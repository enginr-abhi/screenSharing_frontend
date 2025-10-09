// script.js (frontend - Complete File with RDP Fixes)

// NOTE: BACKEND_URL ko apne live backend URL se badal lein
const BACKEND_URL = "https://screensharing-test-backend.onrender.com"; 
const socket = io(BACKEND_URL, { transports: ["websocket"] });

/* UI elements */
const nameInput = document.getElementById("name");
const roomInput = document.getElementById("room");
const joinBtn = document.getElementById("joinBtn");
const shareBtn = document.getElementById("shareBtn");
const stopBtn = document.getElementById("stopBtn");
const leaveBtn = document.getElementById("leaveBtn");
const statusEl = document.getElementById("status");
const permBox = document.getElementById("perm");
const acceptBtn = document.getElementById("acceptBtn");
const rejectBtn = document.getElementById("rejectBtn");
const localVideo = document.getElementById("local");
const remoteVideo = document.getElementById("remote");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const userListEl = document.getElementById("userList");

let pc, localStream, remoteStream;
let roomId = null;
let currentUser = null;
let canFullscreen = false;

/* UI helpers */
function hideInputs() {
  document.querySelector('label[for="name"]').style.display = 'none';
  document.querySelector('label[for="room"]').style.display = 'none';
  nameInput.style.display = 'none';
  roomInput.style.display = 'none';
  joinBtn.style.display = 'none';
  shareBtn.disabled = false;
  leaveBtn.disabled = false;
}
function showInputs() {
  document.querySelector('label[for="name"]').style.display = '';
  document.querySelector('label[for="room"]').style.display = '';
  nameInput.style.display = '';
  roomInput.style.display = '';
  joinBtn.style.display = '';
  shareBtn.disabled = true;
  stopBtn.disabled = true;
  leaveBtn.disabled = true;
  statusEl.textContent = '';
}

/* show online users */
function updateUserList(users) {
  if (!userListEl) return;
  userListEl.innerHTML = users.map(u => `
    <div class="user-item">
    <div>
    <div class="user-name">${u.name}</div>
    <div class="user-room">Room: ${u.roomId || 'N/A'}</div>
    </div>
    <div class="status-dot ${u.isAgent ? "status-online" : "status-online"}"></div>
    </div>
    `).join("");
  }
  
  /* Join */
  joinBtn.onclick = () => {
    const name = nameInput.value.trim();
    roomId = roomInput.value.trim();
    if (!name || !roomId) return alert("Enter name and room");
    currentUser = name;
    socket.emit("set-name", { name });
    socket.emit("join-room", { roomId, name, isAgent: false });
    hideInputs();
    statusEl.textContent = `✅ ${name} Joined ${roomId}`;
  };

  /* Request Access (viewer) */
  shareBtn.onclick = () => {
    if (!roomId) return alert("Join a room first");
    socket.emit("request-screen", { roomId, from: socket.id });
    statusEl.textContent = "⏳ Request sent — waiting for peer to accept...";
  };
  
  /* Incoming screen-request (target side) */
  socket.on("screen-request", ({ from, name }) => {
    permBox.style.display = "block";
    document.getElementById("permText").textContent = `${name || 'Peer'} wants to view your screen`;
    
    acceptBtn.onclick = () => {
      permBox.style.display = "none";
      const encoded = encodeURIComponent(roomId || roomInput.value || "room1");
      window.open(`${BACKEND_URL}/download-agent?room=${encoded}`, "_blank");
      
      socket.emit("permission-response", { to: from, accepted: true });
      statusEl.textContent = "✅ Accepted — agent download started (please run the agent)";
    };
    
    rejectBtn.onclick = () => {
      permBox.style.display = "none";
      socket.emit("permission-response", { to: from, accepted: false });
      statusEl.textContent = "❌ Rejected";
    };
  });
  
  /* Permission result on requester side */
  socket.on("permission-result", (accepted) => {
    if (!accepted) {
      statusEl.textContent = "❌ Request denied by peer";
      return;
    }
    statusEl.textContent = "✅ Request accepted — requesting agent to start RDP...";
    socket.emit("start-rdp-capture", { roomId });
  });
  
  /* Backend tells us agent is ready with RDP details */
  socket.on("windows-rdp-connect", (data) => {
    statusEl.textContent = "✅ Remote system ready — launching RDP client...";
    
    // FIX 1: Send a fixed capture-info to the Agent for mouse position calculation
    // This enables remote control functionality
    socket.emit("capture-info", {
      roomId: roomId,
      captureWidth: 1280, 
      captureHeight: 720, 
      devicePixelRatio: 1 
    });
    
    // FIX 2: Launch local RDP client
    try {
      window.open(`ms-rdp:fulladdress=s:${data.ip}`, "_blank");
      alert(`RDP Client launched. IP: ${data.ip}. Use this IP and your credentials to connect.`);
    } catch (e) {
      alert(`Remote ready: ${data.computerName} (${data.ip}). Connect using Remote Desktop (mstsc).`);
    }
    
    // Enable remote control handlers
    enableRemoteControl();
  });
  
  /* Optional: capture-info (for browser capture fallback) */
  socket.on("capture-info", info => {
    console.log("capture-info received:", info);
});

/* Stop-share */
socket.on("stop-share", ({ name }) => {
  if (remoteStream) remoteStream.getTracks().forEach(t => t.stop());
  remoteVideo.srcObject = null;
  statusEl.textContent = `🛑 ${name || 'Peer'} stopped sharing`;
  stopBtn.disabled = true;
  shareBtn.disabled = false;
});

/* Signaling (WebRTC fallback) - kept for potential future use */
socket.on("signal", async ({ desc, candidate }) => {
  if (desc) {
    if (!pc) startPeer(false);
    try {
      await pc.setRemoteDescription(desc);
      if (desc.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("signal", { roomId, desc: pc.localDescription });
      }
    } catch (e) {
      console.error("Signal error:", e);
    }
  } else if (candidate) {
    try { if (pc) await pc.addIceCandidate(candidate); } catch (e) { console.error(e); }
  }
});

/* Peer connection functions (left for fallback) */
function startPeer(isOfferer) {
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  
  pc.onicecandidate = e => {
    if (e.candidate) socket.emit("signal", { roomId, candidate: e.candidate });
  };
  
  pc.ontrack = e => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    remoteStream.addTrack(e.track);
    remoteVideo.onloadedmetadata = () => {
      const remoteWrapper = document.querySelector(".remote-wrapper");
      if (canFullscreen && remoteWrapper.requestFullscreen) {
        remoteWrapper.requestFullscreen().catch(err => console.warn("Auto-fullscreen failed:", err));
        canFullscreen = false;
      }
    };
  };
  
  if (isOfferer) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("signal", { roomId, desc: pc.localDescription });
      } catch (err) { console.error("Negotiation failed:", err); }
    };
  }

  enableRemoteControl();
}

/* remote control handlers (these go to agent) */
function enableRemoteControl() {
  
  const handleMouse = (e, type) => {
    // Calculate relative position (0 to 1)
    const rect = remoteVideo.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    // Send relative position and event type/button
    socket.emit("control", { type, x, y, button: e.button }); 
  };
  
  remoteVideo.addEventListener("mousemove", e => handleMouse(e, "mousemove"));
  
  ["click", "dblclick", "mousedown", "mouseup"].forEach(evt => {
    remoteVideo.addEventListener(evt, e => handleMouse(e, evt));
  });
  
  remoteVideo.addEventListener("wheel", e => socket.emit("control", { type: "wheel", deltaY: e.deltaY }));
  // Keyboard events are registered on the whole document
  document.addEventListener("keydown", e => socket.emit("control", { type: "keydown", key: e.key }));
  document.addEventListener("keyup", e => socket.emit("control", { type: "keyup", key: e.key }));
}

/* fullscreen button */
fullscreenBtn.onclick = () => {
  const remoteWrapper = document.querySelector(".remote-wrapper");
  if (remoteWrapper.requestFullscreen) remoteWrapper.requestFullscreen();
};

/* user list updates */
socket.on("peer-list", users => updateUserList(users));
socket.on("peer-joined", () => socket.emit("get-peers"));
socket.on("peer-left", () => socket.emit("get-peers"));

/* Leave / Stop UI */
stopBtn.onclick = () => {
  const name = currentUser || nameInput.value.trim();
  socket.emit("stop-share", { roomId, name });
  if (remoteStream) remoteStream.getTracks().forEach(t => t.stop());
  remoteVideo.srcObject = null;
  statusEl.textContent = "🛑 Stopped";
  stopBtn.disabled = true;
  shareBtn.disabled = false;
};

leaveBtn.onclick = () => {
  if (!roomId) return;
  const name = currentUser || nameInput.value.trim();
  socket.emit("leave-room", { roomId, name });
  // UI cleanup
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; localVideo.srcObject = null; }
  if (remoteStream) { remoteStream.getTracks().forEach(t => t.stop()); remoteStream = null; remoteVideo.srcObject = null; }
  if (pc) { pc.close(); pc = null; }
  showInputs();
  userListEl.innerHTML = "";
  roomId = null;
  currentUser = null;
  statusEl.textContent = "🚪 Left the room";
};

/* debug */
socket.on("connect", () => console.log("Socket connected:", socket.id));
socket.on("connect_error", e => console.error("Socket connect_error:", e));
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
const statusText = document.getElementById("statusText");
const statusIndicator = document.querySelector(".status-indicator");
const permBox = document.getElementById("perm");
const acceptBtn = document.getElementById("acceptBtn");
const rejectBtn = document.getElementById("rejectBtn");
const localVideo = document.getElementById("local");
const remoteVideo = document.getElementById("remote");
const remoteImg = document.getElementById("remoteImg");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const userListEl = document.getElementById("userList");
const userCountEl = document.getElementById("userCount");

let pc, localStream, remoteStream;
let roomId = null;
let currentUser = null;
let canFullscreen = false;

/* UI helpers */
function updateStatus(text, type = "default") {
  statusText.textContent = text;
  statusIndicator.className = "status-indicator";
  if (type === "connected") {
    statusIndicator.classList.add("status-connected");
  } else if (type === "pending") {
    statusIndicator.classList.add("status-pending");
  }
}

function hideInputs() {
  document.querySelector('label[for="name"]').classList.add('hidden');
  document.querySelector('label[for="room"]').classList.add('hidden');
  nameInput.classList.add('hidden');
  roomInput.classList.add('hidden');
  joinBtn.classList.add('hidden');
  shareBtn.disabled = false;
  leaveBtn.disabled = false;
}

function showInputs() {
  document.querySelector('label[for="name"]').classList.remove('hidden');
  document.querySelector('label[for="room"]').classList.remove('hidden');
  nameInput.classList.remove('hidden');
  roomInput.classList.remove('hidden');
  joinBtn.classList.remove('hidden');
  shareBtn.disabled = true;
  stopBtn.disabled = true;
  leaveBtn.disabled = true;
  updateStatus("Not connected");
}

/* show online users */
function updateUserList(users) {
  if (!userListEl) return;

  if (users.length === 0) {
    userListEl.innerHTML = `
      <div class="text-center" style="color: var(--text-muted); padding: 20px;">
        <i class="fas fa-users-slash" style="font-size: 24px; margin-bottom: 8px;"></i>
        <p>No users online</p>
      </div>
    `;
    userCountEl.textContent = "0";
    return;
  }

  userListEl.innerHTML = users.map(u => `
    <div class="user-item">
      <div class="user-info">
        <div class="user-name">${u.name}</div>
        <div class="user-room">Room: ${u.roomId || 'N/A'}</div>
      </div>
      <div class="status-dot ${u.isAgent ? "status-online" : "status-online"}"></div>
    </div>
  `).join("");

  userCountEl.textContent = users.length;
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
  updateStatus(`✅ ${name} Joined ${roomId}`, "connected");
};

/* Request Access (viewer) */
shareBtn.onclick = () => {
  if (!roomId) return alert("Join a room first");
  socket.emit("request-screen", { roomId, from: socket.id });
  updateStatus("⏳ Request sent — waiting for peer to accept...", "pending");
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
    updateStatus("✅ Accepted — agent download started (please run the agent)", "connected");
  };

  rejectBtn.onclick = () => {
    permBox.style.display = "none";
    socket.emit("permission-response", { to: from, accepted: false });
    updateStatus("❌ Rejected", "default");
  };
});

/* Permission result on requester side */
socket.on("permission-result", (accepted) => {
  if (!accepted) {
    updateStatus("❌ Request denied by peer", "default");
    return;
  }
  updateStatus("✅ Request accepted — requesting agent to start RDP...", "pending");
  socket.emit("start-rdp-capture", { roomId });
});

/* Backend tells us agent is ready with RDP details */
socket.on("windows-rdp-connect", (data) => {
  updateStatus("✅ Remote system ready — launching RDP client...", "connected");

  // FIX 1: Send capture-info to agent
  socket.emit("capture-info", {
    roomId: roomId,
    captureWidth: 1280,
    captureHeight: 720,
    devicePixelRatio: 1
  });

  try {
    window.open(`ms-rdp:fulladdress=s:${data.ip}`, "_blank");
    alert(`RDP Client launched. IP: ${data.ip}. Use this IP and your credentials to connect.`);
  } catch (e) {
    alert(`Remote ready: ${data.computerName} (${data.ip}). Connect using Remote Desktop (mstsc).`);
  }

  enableRemoteControl();
});

/* ✅ FIX: Receive screen frames from agent (image-based streaming) */
socket.on("screen-frame", ({ image }) => {
  if (image && remoteImg) {
    remoteImg.src = `data:image/jpeg;base64,${image}`;
    remoteImg.style.display = "block";
    remoteVideo.style.display = "none";
  }
});

/* Optional: capture-info */
socket.on("capture-info", info => {
  console.log("capture-info received:", info);
});

/* Stop-share */
socket.on("stop-share", ({ name }) => {
  if (remoteStream) remoteStream.getTracks().forEach(t => t.stop());
  remoteVideo.srcObject = null;
  if (remoteImg) remoteImg.src = "";
  updateStatus(`🛑 ${name || 'Peer'} stopped sharing`, "default");
  stopBtn.disabled = true;
  shareBtn.disabled = false;
});

/* Signaling (WebRTC fallback) */
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

/* Peer connection (fallback) */
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

/* Remote control (mouse/keyboard) */
function enableRemoteControl() {
  const handleMouse = (e, type) => {
    const rect = remoteVideo.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    socket.emit("control", { type, x, y, button: e.button });
  };

  remoteVideo.addEventListener("mousemove", e => handleMouse(e, "mousemove"));
  ["click", "dblclick", "mousedown", "mouseup"].forEach(evt => {
    remoteVideo.addEventListener(evt, e => handleMouse(e, evt));
  });
  remoteVideo.addEventListener("wheel", e => socket.emit("control", { type: "wheel", deltaY: e.deltaY }));

  document.addEventListener("keydown", e => socket.emit("control", { type: "keydown", key: e.key }));
  document.addEventListener("keyup", e => socket.emit("control", { type: "keyup", key: e.key }));
}

/* Fullscreen */
fullscreenBtn.onclick = () => {
  const remoteWrapper = document.querySelector(".remote-wrapper");
  if (remoteWrapper.requestFullscreen) remoteWrapper.requestFullscreen();
};

/* Peer list updates */
socket.on("peer-list", users => updateUserList(users));
socket.on("peer-joined", () => socket.emit("get-peers"));
socket.on("peer-left", () => socket.emit("get-peers"));

/* Stop / Leave */
stopBtn.onclick = () => {
  const name = currentUser || nameInput.value.trim();
  socket.emit("stop-share", { roomId, name });
  if (remoteStream) remoteStream.getTracks().forEach(t => t.stop());
  remoteVideo.srcObject = null;
  if (remoteImg) remoteImg.src = "";
  updateStatus("🛑 Stopped", "default");
  stopBtn.disabled = true;
  shareBtn.disabled = false;
};

leaveBtn.onclick = () => {
  if (!roomId) return;
  const name = currentUser || nameInput.value.trim();
  socket.emit("leave-room", { roomId, name });

  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; localVideo.srcObject = null; }
  if (remoteStream) { remoteStream.getTracks().forEach(t => t.stop()); remoteStream = null; remoteVideo.srcObject = null; }
  if (pc) { pc.close(); pc = null; }

  if (remoteImg) remoteImg.src = "";
  showInputs();
  userListEl.innerHTML = "";
  roomId = null;
  currentUser = null;
  updateStatus("🚪 Left the room", "default");
};

/* Debug */
socket.on("connect", () => console.log("Socket connected:", socket.id));
socket.on("connect_error", e => console.error("Socket connect_error:", e));

showInputs();

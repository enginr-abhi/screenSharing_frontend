// * script.js */
const socket = io("https://screensharing-test-backend.onrender.com",{
  transports:["websocket"]
});

const nameInput = document.getElementById("name");
const roomInput = document.getElementById("room");
const joinBtn = document.getElementById("joinBtn");
const shareBtn = document.getElementById("shareBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const permBox = document.getElementById("perm");
const acceptBtn = document.getElementById("acceptBtn");
const rejectBtn = document.getElementById("rejectBtn");
const localVideo = document.getElementById("local");
const remoteVideo = document.getElementById("remote");
const fullscreenBtn = document.getElementById("fullscreenBtn");

let pc, localStream, remoteStream;
let roomId;


function hideInputs() {
  nameInput.style.display = "none";
  roomInput.style.display = "none";
  document.querySelector('label[for="name"]').style.display = 'none';
  document.querySelector('label[for="room"]').style.display = 'none';
  joinBtn.style.display = 'none';
  shareBtn.disabled = false;
}

// ---- Join ----
joinBtn.onclick = () => {
  const name = nameInput.value.trim();
  roomId = roomInput.value.trim();
  if (!name || !roomId) return alert("Enter name and room");

  socket.emit("set-name", { name });
  socket.emit("join-room", { roomId , name, isAgent: false});
  hideInputs();
  statusEl.textContent = `✅ ${name} Joined ${roomId}`;
};

// ---- Request screen ----
shareBtn.onclick = () => {
  socket.emit("request-screen", { roomId, from: socket.id });
  statusEl.textContent = "⏳ Requesting screen...";
};

// ---- Stop ----
stopBtn.onclick = () => {
  socket.emit("stop-share", roomId);
  if (remoteStream) remoteStream.getTracks().forEach(t => t.stop());
  remoteVideo.srcObject = null;
  statusEl.textContent = "🛑 Stopped";
  stopBtn.disabled = true;
  shareBtn.disabled = false;
};

// ---- Incoming screen request ----
socket.on("screen-request", ({ from, name }) => {
  permBox.style.display = "block";
  document.getElementById("permText").textContent = `${name} wants to view your screen`;

  acceptBtn.onclick = async () => {
    permBox.style.display = "none";
      // 🔹 Show Agent download popup
  if (confirm("For full remote control please download & run the Agent app.\nDo you want to download it now?")) {
      // ✅ agent.exe download start hoga
    window.open("https://screensharing-test-backend.onrender.com/download-agent", "_blank");
  }
    try {
      localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      localVideo.srcObject = localStream;

      const track = localStream.getVideoTracks()[0];
      const settings = track.getSettings();
      socket.emit("capture-info", {
        roomId,
        captureWidth: settings.width,
        captureHeight: settings.height,
        devicePixelRatio: window.devicePixelRatio || 1,
      });

      startPeer(true);
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      socket.emit("permission-response", { to: from, accepted: true });
      stopBtn.disabled = false;
      shareBtn.disabled = true;
    } catch (err) {
      console.error(err);
      socket.emit("permission-response", { to: from, accepted: false });
    }
  };

  rejectBtn.onclick = () => {
    permBox.style.display = "none";
    socket.emit("permission-response", { to: from, accepted: false });
  };
});

// ---- Permission result ----
socket.on("permission-result", accepted => {
  if (!accepted) {
    statusEl.textContent = "❌ Request denied";
    return;
  }
  statusEl.textContent = "✅ Request accepted";
  startPeer(false);

  
  // 🔹 enable stop button for viewer too
  stopBtn.disabled = false;
  shareBtn.disabled = true;
});

// ---- Stop-share ----
socket.on("stop-share", () => {
  if (remoteStream) remoteStream.getTracks().forEach(t => t.stop());
  remoteVideo.srcObject = null;
  statusEl.textContent = "🛑 Sharing stopped";
  stopBtn.disabled = true;
  shareBtn.disabled = false;
});

// ---- WebRTC signaling ----
socket.on("signal", async ({ desc, candidate }) => {
  if (desc) {
    await pc.setRemoteDescription(desc);
    if (desc.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("signal", { roomId, desc: pc.localDescription });
    }
  } else if (candidate) {
    try { await pc.addIceCandidate(candidate); } catch (e) { console.error(e); }
  }
});

// ---- Peer ----
function startPeer(isOfferer) {
  pc = new RTCPeerConnection({
  iceServers: [
    {
      urls: 'stun:stun.l.google.com:19302'
    }
  ]
});
  pc.onicecandidate = e => { if (e.candidate) socket.emit("signal", { roomId, candidate: e.candidate }); };
  pc.ontrack = e => {
    if (!remoteStream) { remoteStream = new MediaStream(); remoteVideo.srcObject = remoteStream; }
    remoteStream.addTrack(e.track);
  };
  if (isOfferer) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", { roomId, desc: pc.localDescription });
    };
  }
  enableRemoteControl();
}

// ---- Remote Control ----
function enableRemoteControl() {
  remoteVideo.addEventListener("mousemove", e => {
    const rect = remoteVideo.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    socket.emit("control", { type: "mousemove", x, y });
  });

  ["click", "dblclick", "mousedown", "mouseup"].forEach(evt => {
    remoteVideo.addEventListener(evt, e => { socket.emit("control", { type: evt, button: e.button }); });
  });

  remoteVideo.addEventListener("wheel", e => { socket.emit("control", { type: "wheel", deltaY: e.deltaY }); });

  document.addEventListener("keydown", e => { socket.emit("control", { type: "keydown", key: e.key }); });
  document.addEventListener("keyup", e => { socket.emit("control", { type: "keyup", key: e.key }); });
}

// ---- Fullscreen ----
fullscreenBtn.onclick = () => { if (remoteVideo.requestFullscreen) remoteVideo.requestFullscreen(); };
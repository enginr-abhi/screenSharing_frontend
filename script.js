const socket = io("https://screensharing-test-backend.onrender.com", { transports: ["websocket"] });

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

// ✅ Extra references for labels
const nameLabel = document.querySelector("label[for='name']");
const roomLabel = document.querySelector("label[for='room']");

let pc, localStream, remoteStream;
let roomId;

// ---- Join ----
joinBtn.onclick = () => {
  const name = nameInput.value.trim();
  roomId = roomInput.value.trim();
  if (!name || !roomId) return alert("Enter name and room");

  socket.emit("set-name", { name });
  socket.emit("join-room", { roomId });

  // 🔥 Hide labels + inputs once joined
  nameInput.style.display = "none";
  roomInput.style.display = "none";
  nameLabel.style.display = "none";
  roomLabel.style.display = "none";

  joinBtn.style.display = "none";
  shareBtn.disabled = false;

  statusEl.textContent = "✅ Joined";
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
  pc = new RTCPeerConnection();
  pc.onicecandidate = e => { if (e.candidate) socket.emit("signal", { roomId, candidate: e.candidate }); };
  pc.ontrack = e => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;

      // 🔥 Send capture-info when video is ready
      remoteVideo.onloadedmetadata = () => {
        socket.emit("capture-info", {
          roomId,
          captureWidth: remoteVideo.videoWidth,
          captureHeight: remoteVideo.videoHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
      };
    }
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
  // ✅ Transparent overlay div
  let overlay = document.getElementById("controlLayer");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "controlLayer";
    Object.assign(overlay.style, {
      position: "absolute",
      top: "0", left: "0", width: "100%", height: "100%",
      cursor: "crosshair", background: "transparent"
    });
    remoteVideo.parentElement.appendChild(overlay);
  }

  overlay.addEventListener("mousemove", e => {
    const x = e.offsetX / overlay.clientWidth;
    const y = e.offsetY / overlay.clientHeight;
    socket.emit("control", { type: "mousemove", x, y });
  });

  ["click", "dblclick", "mousedown", "mouseup"].forEach(evt => {
    overlay.addEventListener(evt, e => {
      socket.emit("control", { type: evt, button: e.button });
    });
  });

  overlay.addEventListener("wheel", e => {
    socket.emit("control", { type: "wheel", deltaY: Math.sign(e.deltaY) });
  });

  document.addEventListener("keydown", e => {
    socket.emit("control", { type: "keydown", key: e.key.toLowerCase() });
  });

  document.addEventListener("keyup", e => {
    socket.emit("control", { type: "keyup", key: e.key.toLowerCase() });
  });
}

// ---- Fullscreen ----
fullscreenBtn.onclick = () => {
  if (remoteVideo.requestFullscreen) remoteVideo.requestFullscreen();
};

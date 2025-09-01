const socket = io("https://screensharing-test-backend.onrender.com", { transports: ["websocket"] });

// DOM Elements
const nameEl = document.getElementById('name');
const roomEl = document.getElementById('room');
const joinBtn = document.getElementById('joinBtn');
const shareBtn = document.getElementById('shareBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const permBox = document.getElementById('perm');
const acceptBtn = document.getElementById('acceptBtn');
const rejectBtn = document.getElementById('rejectBtn');
const localV = document.getElementById('local');
const remoteV = document.getElementById('remote');
const fullscreenBtn = document.getElementById('fullscreenBtn');

// 🔹 Remote cursor overlay (Sharer side)
const cursor = document.createElement('div');
cursor.id = "remoteCursor";
cursor.style.position = "absolute";
cursor.style.width = "14px";
cursor.style.height = "14px";
cursor.style.background = "red";
cursor.style.borderRadius = "50%";
cursor.style.pointerEvents = "none";
cursor.style.display = "none";
cursor.style.zIndex = "9999";
document.body.appendChild(cursor);

// State
let roomId = null;
let pc = null;
let screenStream = null;
let pendingRequesterId = null;
let controlChannel = null;

// Helpers
const setStatus = (s) => statusEl.textContent = s || '';

function hideInputs() {
  document.getElementById('name').style.display = 'none';
  document.getElementById('room').style.display = 'none';
  document.querySelector('label[for="name"]').style.display = 'none';
  document.querySelector('label[for="room"]').style.display = 'none';
  joinBtn.style.display = 'none';
}

// --- PeerConnection setup
function ensurePC() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { roomId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    remoteV.srcObject = e.streams[0];
    remoteV.play().catch(err => console.error("Autoplay error:", err));
  };

  pc.ondatachannel = (event) => {
    if (event.channel.label === "control") {
      controlChannel = event.channel;
      controlChannel.onopen = () => console.log("Viewer: control channel OPEN ✅");

      document.addEventListener("keydown", (e) => {
        if (controlChannel.readyState === "open") controlChannel.send(JSON.stringify({ type: "keydown", key: e.key }));
        console.log("Viewer pressed key:", e.key);
      });


      remoteV.addEventListener("mousemove", (e) => {
        if (controlChannel.readyState === "open") {
          const rect = remoteV.getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width;
          const y = (e.clientY - rect.top) / rect.height;
          controlChannel.send(JSON.stringify({ type: "mousemove", x, y }));
        }
      });

      remoteV.addEventListener("click", (e) => {
        if (controlChannel.readyState === "open") {
          const rect = remoteV.getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width;
          const y = (e.clientY - rect.top) / rect.height;
          controlChannel.send(JSON.stringify({ type: "click", x, y, button: e.button }));
          console.log(`Viewer clicked at: ${x.toFixed(2)}, ${y.toFixed(2)}`); // Viewer console
        }
      });
    }
  };

  return pc;
}

// --- Reset
function resetSharingUI(msg = "Stopped") {
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  localV.srcObject = null;
  remoteV.srcObject = null;
  shareBtn.disabled = false;
  stopBtn.disabled = true;
  joinBtn.disabled = false;
  setStatus(msg);
  if (pc) { pc.close(); pc = null; }
  controlChannel = null;
}

// --- Join Room
joinBtn.onclick = () => {
  if (!nameEl.value.trim()) return alert('Enter name');
  roomId = roomEl.value.trim();
  if (!roomId) return alert('Enter room');
  socket.emit('join-room', roomId);
  joinBtn.disabled = true;
  shareBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Joined ' + roomId);
  ensurePC();
};

// --- Room events
socket.on('room-full', () => alert('Room full (max 2)'));
socket.on('peer-joined', () => setStatus('Peer joined'));

// --- Request screen
shareBtn.onclick = () => {
  if (!roomId) return alert('Join a room first');
  socket.emit('request-screen', { roomId, from: socket.id });
};

// --- Incoming request
socket.on('screen-request', ({ from }) => {
  pendingRequesterId = from;
  permBox.style.display = 'block';
});

// --- Accept request (Sharer)
acceptBtn.onclick = async () => {
  if (!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted: true });
  permBox.style.display = 'none';
  hideInputs();

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    localV.srcObject = screenStream;

    const pcInstance = ensurePC();
    controlChannel = pcInstance.createDataChannel("control");
    controlChannel.onopen = () => console.log("Sharer: control channel OPEN ✅");

    // Sharer: handle viewer control
    controlChannel.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);

        if (data.type === "keydown") console.log("Sharer got key:", data.key); //✅ Sharer console

        if (data.type === "mousemove" || data.type === "click") {
          const [track] = screenStream.getVideoTracks();
          const settings = track.getSettings();
          const videoW = settings.width || window.innerWidth;
          const videoH = settings.height || window.innerHeight;

          // Calculate cursor position relative to current window size
          const left = Math.floor(data.x * window.innerWidth);
          const top = Math.floor(data.y * window.innerHeight);

          cursor.style.left = left + "px";
          cursor.style.top = top + "px";
          cursor.style.display = "block";

          if (data.type === "click") {
            console.log(`Sharer received click at: ${data.x.toFixed(2)}, ${data.y.toFixed(2)}`); // ✅ Sharer console
            cursor.style.transform = "scale(1)";
            cursor.style.background = "blue";
            setTimeout(() => { cursor.style.transform = "scale(1)"; cursor.style.background = "red"; }, 300);

            const el = document.elementFromPoint(left, top);
            if (el) el.click();
          }
        }
      } catch (err) { console.error("Invalid control message", err); }
    };

    screenStream.getTracks().forEach(track => pcInstance.addTrack(track, screenStream));
    const offer = await pcInstance.createOffer();
    await pcInstance.setLocalDescription(offer);
    socket.emit('signal', { roomId, desc: pcInstance.localDescription });

    shareBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('Sharing your screen...');
  } catch (err) {
    console.error(err);
    alert('Screen capture failed: ' + err.message);
    resetSharingUI('');
  }
  pendingRequesterId = null;
};

// --- Reject request
rejectBtn.onclick = () => {
  if (!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted: false });
  permBox.style.display = 'none';
  pendingRequesterId = null;
  shareBtn.disabled = false;
};

// --- Permission result (Viewer)
socket.on('permission-result', (accepted) => {
  if (accepted) {
    setStatus('Peer accepted. Waiting for connection…');
    hideInputs();
    ensurePC();
    stopBtn.disabled = false;
    shareBtn.disabled = true;
  } else {
    setStatus('Peer rejected your request.');
    shareBtn.disabled = false;
  }
});

// --- Signaling
socket.on('signal', async ({ desc, candidate }) => {
  try {
    const pcInstance = ensurePC();
    if (desc) {
      if (desc.type === 'offer') {
        await pcInstance.setRemoteDescription(desc);
        const answer = await pcInstance.createAnswer();
        await pcInstance.setLocalDescription(answer);
        socket.emit('signal', { roomId, desc: pcInstance.localDescription });
        setStatus('Connected. Viewing peer screen.');
      } else if (desc.type === 'answer') {
        await pcInstance.setRemoteDescription(desc);
        setStatus('Connected. Viewing peer screen.');
      }
    } else if (candidate) await pcInstance.addIceCandidate(candidate);
  } catch (e) { console.error('Signal error:', e); }
});

// --- Stop sharing
function stopSharing() {
  socket.emit('stop-share', roomId);
  resetSharingUI('You stopped sharing');
}
stopBtn.onclick = stopSharing;

socket.on('remote-stopped', () => resetSharingUI('Peer stopped sharing'));
socket.on('peer-left', () => resetSharingUI('Peer left'));

// --- Fullscreen
fullscreenBtn.onclick = () => {
  if (!document.fullscreenElement) remoteV.requestFullscreen();
  else document.exitFullscreen();
};

// --- Cleanup
window.addEventListener('beforeunload', () => {
  if (roomId) socket.emit('stop-share', roomId);
});

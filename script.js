// Replace with your Render backend URL
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
const cursor = document.createElement('div');
cursor.id = "remoteCursor";
cursor.style.position = "absolute";
cursor.style.width = "10px";
cursor.style.height = "10px";
cursor.style.background = "red";
cursor.style.borderRadius = "50%";
cursor.style.pointerEvents = "none";
cursor.style.display = "none";
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

function ensurePC() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { roomId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    remoteV.srcObject = e.streams[0];
  };

  pc.ondatachannel = (e) => {
    if (e.channel.label === "control") setupControlChannel(e.channel);
  };

  return pc;
}

function setupControlChannel(channel) {
  controlChannel = channel;
  controlChannel.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data.type === "key") console.log("Sharer got KEY:", data.key);
    if (data.type === "mouse-move") {
      cursor.style.display = "block";
      cursor.style.left = data.x + "px";
      cursor.style.top = data.y + "px";
    }
    if (data.type === "mouse-click") {
      cursor.style.left = data.x + "px";
      cursor.style.top = data.y + "px";
      console.log(`Sharer got MOUSE CLICK: (${data.x},${data.y}) button=${data.button}`);
    }
  };
}

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
}

// Join room
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

socket.on('room-full', () => alert('Room full (max 2)'));
socket.on('peer-joined', () => setStatus('Peer joined'));

// Request screen
shareBtn.onclick = async () => {
  if (!roomId) return alert('Join a room first');
  socket.emit('request-screen', { roomId, from: socket.id });
  setStatus('Waiting for peer permission…');
  shareBtn.disabled = true;
};

// Permission request
socket.on('screen-request', ({ from }) => {
  pendingRequesterId = from;
  permBox.style.display = 'block';
});

// Accept / Reject
acceptBtn.onclick = async () => {
  if (!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted: true });
  permBox.style.display = 'none';
  hideInputs();

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    localV.srcObject = screenStream;

    const pcInstance = ensurePC();
    screenStream.getTracks().forEach(track => pcInstance.addTrack(track, screenStream));

    const dc = pcInstance.createDataChannel("control");
    setupControlChannel(dc);

    const offer = await pcInstance.createOffer();
    await pcInstance.setLocalDescription(offer);
    socket.emit('signal', { roomId, desc: pcInstance.localDescription });

    shareBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('Sharing your screen…');
  } catch (err) {
    console.error(err);
    alert('Screen capture failed: ' + err.message);
    resetSharingUI('');
  }
  pendingRequesterId = null;
};

rejectBtn.onclick = () => {
  if (!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted: false });
  permBox.style.display = 'none';
  pendingRequesterId = null;
  shareBtn.disabled = false;
};

// Permission result
socket.on('permission-result', (accepted) => {
  if (accepted) {
    setStatus('Peer accepted. Waiting for connection…');
    hideInputs();
    ensurePC();
    stopBtn.disabled = false;

    // Keyboard + mouse
    document.addEventListener("keydown", (e) => {
      if (controlChannel?.readyState === "open") controlChannel.send(JSON.stringify({ type: "key", key: e.key }));
    });
    document.addEventListener("mousemove", (e) => {
      if (controlChannel?.readyState === "open") controlChannel.send(JSON.stringify({ type: "mouse-move", x: e.clientX, y: e.clientY }));
    });
    document.addEventListener("click", (e) => {
      if (controlChannel?.readyState === "open") controlChannel.send(JSON.stringify({ type: "mouse-click", x: e.clientX, y: e.clientY, button: e.button }));
    });

  } else {
    setStatus('Peer rejected your request.');
    shareBtn.disabled = false;
  }
});

// Signaling
socket.on('signal', async ({ desc, candidate }) => {
  const pcInstance = ensurePC();
  try {
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

// Stop sharing
stopBtn.onclick = () => {
  resetSharingUI('Stopped by you');
  if (roomId) socket.emit('stop-share', roomId);
};

socket.on('remote-stopped', () => resetSharingUI('Peer stopped sharing'));
socket.on('peer-left', () => resetSharingUI('Peer left'));

// Fullscreen
fullscreenBtn.onclick = () => {
  if (!document.fullscreenElement) remoteV.requestFullscreen();
  else document.exitFullscreen();
};

// Cleanup
window.addEventListener('beforeunload', () => {
  if (roomId) socket.emit('stop-share', roomId);
});

const socket   = io("https://screensharing-test-backend.onrender.com", { transports:["websocket"] });

const roomEl   = document.getElementById('room');
const joinBtn  = document.getElementById('joinBtn');
const shareBtn = document.getElementById('shareBtn');
const stopBtn  = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const permBox  = document.getElementById('perm');
const acceptBt = document.getElementById('acceptBtn');
const rejectBt = document.getElementById('rejectBtn');
const localV   = document.getElementById('local');
const remoteV  = document.getElementById('remote');
const fullscreenBtn = document.getElementById('fullscreenBtn');

let roomId = null;
let pc = null;
let screenStream = null;
let pendingRequesterId = null;

const setStatus = (s) => statusEl.textContent = s || '';

// --- PeerConnection setup
function ensurePC() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { roomId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    remoteV.srcObject = e.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      setStatus('Peer disconnected');
    }
  };

  return pc;
}

// --- Reset UI & stop sharing
function resetSharingUI(msg = "Stopped") {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  localV.srcObject = null;
  remoteV.srcObject = null;

  shareBtn.disabled = false;    
  stopBtn.disabled = false;     
  joinBtn.disabled = false;     
  setStatus(msg);
}

// --- Join Room
joinBtn.onclick = () => {
  roomId = roomEl.value.trim();
  if (!roomId) return alert('Enter room');
  socket.emit('join-room', roomId);
  joinBtn.disabled = true;
  shareBtn.disabled = false;
  stopBtn.disabled = false; 
  setStatus('Joined ' + roomId);
};

// --- Room full / peer joined
socket.on('room-full', () => alert('Room full (max 2)'));
socket.on('peer-joined', () => setStatus('Peer joined'));

// --- Request to share screen
shareBtn.onclick = () => {
  if (!roomId) return alert('Join a room first');
  socket.emit('request-screen', { roomId, from: socket.id });
  setStatus('Waiting for peer permission…');
  shareBtn.disabled = true;
};

// --- Receive permission request
socket.on('screen-request', ({ from }) => {
  pendingRequesterId = from;
  permBox.style.display = 'block';
});

// --- Accept request -> share screen
acceptBt.onclick = async () => {
  if (!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted: true });
  permBox.style.display = 'none';

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    localV.srcObject = screenStream;

    ensurePC();
    screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { roomId, desc: pc.localDescription });

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

// --- Reject request
rejectBt.onclick = () => {
  if (!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted: false });
  permBox.style.display = 'none';
  pendingRequesterId = null;
  shareBtn.disabled = false; 
};

// --- Handle permission result for viewer
socket.on('permission-result', (accepted) => {
  if (accepted) {
    setStatus('Peer accepted. Connecting…');
    shareBtn.disabled = true; 
  } else {
    setStatus('Peer rejected your request.');
    shareBtn.disabled = false; 
  }
});

// --- Signaling
socket.on('signal', async ({ desc, candidate }) => {
  try {
    ensurePC();
    if (desc) {
      if (desc.type === 'offer') {
        await pc.setRemoteDescription(desc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { roomId, desc: pc.localDescription });
      } else if (desc.type === 'answer') {
        await pc.setRemoteDescription(desc);
      }
    } else if (candidate) {
      await pc.addIceCandidate(candidate);
    }
  } catch (e) {
    console.error('Signal error:', e);
  }
});

// --- Stop sharing
function stopSharing() {
  resetSharingUI('Stopped by you');
  if (roomId) socket.emit('stop-share', roomId);
}
stopBtn.onclick = stopSharing;

// --- Remote stop / peer leave
socket.on('remote-stopped', () => resetSharingUI('Peer stopped sharing'));
socket.on('peer-left', () => resetSharingUI('Peer left'));

// --- Cleanup on unload
window.addEventListener('beforeunload', () => {
  if (roomId) socket.emit('stop-share', roomId);
});

// --- Fullscreen button
fullscreenBtn.onclick = () => {
  if (!document.fullscreenElement) {
    remoteV.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
};


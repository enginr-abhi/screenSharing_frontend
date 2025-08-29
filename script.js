const socket = io("https://screensharing-test-backend.onrender.com", { transports: ["websocket"] });
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

let roomId = null;
let pc = null;
let screenStream = null;
let pendingRequesterId = null;
let controlChannel = null;   // NEW

const setStatus = (s) => statusEl.textContent = s || '';

function hideInputs() {
  document.getElementById('name').style.display = 'none';
  document.getElementById('room').style.display = 'none';
  document.querySelector('label[for="name"]').style.display = 'none';
  document.querySelector('label[for="room"]').style.display = 'none';
  joinBtn.style.display = 'none';
}

// --- PeerConnection setup (both sides)
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

  // --- Viewer side: receive control channel
  pc.ondatachannel = (event) => {
    console.log("Viewer: got DataChannel", event.channel.label);

    if (event.channel.label === "control") {
      controlChannel = event.channel;

      controlChannel.onopen = () => {
        console.log("Viewer: control channel OPEN ✅");
      };

      controlChannel.onmessage = (e) => {
        console.log("Viewer got message:", e.data);
      };

      // send keys from viewer → sharer
      document.addEventListener("keydown", (e) => {
        if (controlChannel.readyState === "open") {
          controlChannel.send(`Key pressed: ${e.key}`);
          console.log("Viewer: sent", e.key);
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
  ensurePC(); // Viewer PC ready from beginning
};

// --- Room events
socket.on('room-full', () => alert('Room full (max 2)'));
socket.on('peer-joined', () => setStatus('Peer joined'));

// --- Request screen
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

// --- Accept request → sharer
acceptBtn.onclick = async () => {
  if (!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted: true });
  permBox.style.display = 'none';
  hideInputs();

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    localV.srcObject = screenStream;

    const pcInstance = ensurePC();

    // --- SHARER side: create control channel
    controlChannel = pcInstance.createDataChannel("control");
    controlChannel.onopen = () => {
      console.log("Sharer: control channel OPEN ✅");
    };
    controlChannel.onmessage = (e) => {
      console.log("Sharer received from viewer →", e.data);
    };

    screenStream.getTracks().forEach(track => pcInstance.addTrack(track, screenStream));

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

// --- Reject
rejectBtn.onclick = () => {
  if (!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted: false });
  permBox.style.display = 'none';
  pendingRequesterId = null;
  shareBtn.disabled = false; 
};

// --- Permission result (viewer)
socket.on('permission-result', (accepted) => {
  if (accepted) {
    setStatus('Peer accepted. Waiting for connection…');
    hideInputs();
    ensurePC(); // PC ready before offer arrives
    stopBtn.disabled = false;
  } else {
    setStatus('Peer rejected your request.');
    shareBtn.disabled = false; 
  }
});

// --- Signaling (both sides)
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
    } else if (candidate) {
      await pcInstance.addIceCandidate(candidate);
    }
  } catch (e) { console.error('Signal error:', e); }
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

// --- Fullscreen
fullscreenBtn.onclick = () => {
  if (!document.fullscreenElement) remoteV.requestFullscreen();
  else document.exitFullscreen();
};

// --- Cleanup
window.addEventListener('beforeunload', () => {
  if (roomId) socket.emit('stop-share', roomId);
});

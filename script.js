const socket   = io("https://screensharing-test-backend.onrender.com",{
  transports:["websocket"]
});
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

let roomId = null;
let pc = null;
let screenStream = null;
let pendingRequesterId = null;
let makingOffer = false;

// helpers
const setStatus = (s) => statusEl.textContent = s || '';
const resetUI = () => {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  if (pc) {
    try { pc.getSenders().forEach(s => { try{ pc.removeTrack(s);}catch(e){} }); } catch(e){}
    pc.close();
    pc = null;
  }
  localV.srcObject = null;
  // remoteV ko blank mat karo jab tak peer clear na kare (viewer keep last frame ok)
  shareBtn.disabled = !roomId;
  stopBtn.disabled = true;
  setStatus('');
  permBox.style.display = 'none';
  pendingRequesterId = null;
};

function ensurePC() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { roomId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    // viewer side: far end screen
    remoteV.srcObject = e.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      pc.restartIce();
    }
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      // leave remote as-is; user may re-share
    }
  };

  return pc;
}

// --- Join
joinBtn.onclick = () => {
  const val = roomEl.value.trim();
  if (!val) return alert('Enter room');
  roomId = val;
  socket.emit('join-room', roomId);
  joinBtn.disabled = true;
  shareBtn.disabled = false;
  setStatus('Joined ' + roomId);
};

socket.on('room-full', () => {
  alert('Room full (max 2).');
  joinBtn.disabled = false;
});

socket.on('peer-joined', () => {
  setStatus('Peer joined');
});

// --- Permission UI (viewer side)
socket.on('screen-request', ({ from }) => {
  pendingRequesterId = from;
  permBox.style.display = 'block';
});

acceptBt.onclick = () => {
  if (!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted: true });
  permBox.style.display = 'none';
  pendingRequesterId = null;
};
rejectBt.onclick = () => {
  if (!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted: false });
  permBox.style.display = 'none';
  pendingRequesterId = null;
};

// --- Sender waits for permission
shareBtn.onclick = () => {
  if (!roomId) return alert('Join a room first');
  socket.emit('request-screen', { roomId, from: socket.id });
  setStatus('Waiting for peer permission…');
  shareBtn.disabled = true;
};

socket.on('permission-result', async (accepted) => {
  if (!accepted) {
    setStatus('Peer declined');
    shareBtn.disabled = false;
    return;
  }
  try {
    // Only sharer captures
    screenStream = await navigator.mediaDevices.getDisplayMedia({video: { frameRate: 15, width: 1280 }, audio: false });
    localV.srcObject = screenStream;

    ensurePC();
    const track = screenStream.getVideoTracks()[0];
    pc.addTrack(track, screenStream);

    // If user stops from browser bar, renegotiate to remove track
    track.addEventListener('ended', stopSharing);

    // Create & send offer (viewer will only answer, no capture)
    makingOffer = true;
    await pc.setLocalDescription(await pc.createOffer());
    socket.emit('signal', { roomId, desc: pc.localDescription });

    stopBtn.disabled = true; // enable after signaling set
    setStatus('Sharing…');
    stopBtn.disabled = false;
  } catch (err) {
    console.error(err);
    alert('Screen capture failed: ' + err.message);
    setStatus('');
    shareBtn.disabled = false;
  }
});

// --- Viewer handles offer (no local capture here)
socket.on('signal', async ({ desc, candidate }) => {
  try {
    ensurePC();

    if (desc) {
      if (desc.type === 'offer') {
        await pc.setRemoteDescription(desc);
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit('signal', { roomId, desc: pc.localDescription });
      } else if (desc.type === 'answer') {
        await pc.setRemoteDescription(desc);
      }
    } else if (candidate) {
      await pc.addIceCandidate(candidate);
    }
  } catch (e) {
    console.error('Signal error:', e);
  } finally {
    makingOffer = false;
  }
});

// --- Stop sharing
function stopSharing() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  if (pc) {
    // remove video senders
    pc.getSenders().forEach(s => {
      if (s.track && s.track.kind === 'video') {
        try { pc.removeTrack(s); } catch (e) {}
      }
    });
    // Renegotiate to inform viewer that track is gone
    pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: true })
      .then(async offer => {
        await pc.setLocalDescription(offer);
        socket.emit('signal', { roomId, desc: pc.localDescription });
      }).catch(()=>{});
  }
  localV.srcObject = null;
  stopBtn.disabled = true;
  shareBtn.disabled = false;
  setStatus('Stopped');
  socket.emit('stop-share', roomId);
}

stopBtn.onclick = stopSharing;

// --- Remote stop / peer leave
socket.on('remote-stopped', () => setStatus('Peer stopped sharing'));
socket.on('peer-left', () => {
  remoteV.srcObject = null;
  setStatus('Peer left');
  // Keep PC for quick reconnect, or reset if you want:
  // resetUI();
});

window.addEventListener('beforeunload', () => {
  try { socket.emit('stop-share', roomId); } catch(e){}
});
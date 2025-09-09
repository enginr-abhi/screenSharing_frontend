const socket = io("https://screensharing-test-backend.onrender.com", { transports: ["websocket"] });

// DOM elements
const nameEl = document.getElementById('name');
const roomEl = document.getElementById('room');
const joinBtn = document.getElementById('joinBtn');
const shareBtn = document.getElementById('shareBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const permBox = document.getElementById('perm');
const permText = document.getElementById('permText');
const acceptBtn = document.getElementById('acceptBtn');
const rejectBtn = document.getElementById('rejectBtn');
const localV = document.getElementById('local');
const remoteV = document.getElementById('remote');
const fullscreenBtn = document.getElementById('fullscreenBtn');

// Remote cursor
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
let role = null;

const setStatus = s => statusEl.textContent = s || '';
function hideInputs() {
  nameEl.style.display = 'none';
  roomEl.style.display = 'none';
  document.querySelector('label[for="name"]').style.display = 'none';
  document.querySelector('label[for="room"]').style.display = 'none';
  joinBtn.style.display = 'none';
}

// --- PeerConnection setup
function ensurePC() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('signal', { roomId, candidate: e.candidate });
  };

  pc.ontrack = e => {
    remoteV.srcObject = e.streams[0];
    remoteV.play().catch(console.error);
  };

  pc.ondatachannel = (event) => {
    if (event.channel.label === "control") {
      controlChannel = event.channel;
      controlChannel.onopen = () => console.log("Viewer: control channel OPEN ✅");

      // --- Keyboard keydown
      document.addEventListener("keydown", e => {
        if (controlChannel?.readyState === "open") {
          let key = e.key.toLowerCase();

          // shortcuts
          if (e.ctrlKey && key === "t") key = "newtab";
          if (e.ctrlKey && key === "w") key = "closetab";
          if (e.ctrlKey && key === "tab") key = "switchtab";

          const ev = { type: "keydown", key };
          controlChannel.send(JSON.stringify(ev));
          socket.emit("control-event", { roomId, event: ev });
        }
      });

      // --- Keyboard keyup
      document.addEventListener("keyup", e => {
        if (controlChannel?.readyState === "open") {
          const ev = { type: "keyup", key: e.key.toLowerCase() };
          controlChannel.send(JSON.stringify(ev));
          socket.emit("control-event", { roomId, event: ev });
        }
      });

      // --- Mouse move
      remoteV.addEventListener("mousemove", e => {
        if (controlChannel?.readyState === "open") {
          const rect = remoteV.getBoundingClientRect();
          const ev = {
            type: "mousemove",
            x: (e.clientX - rect.left) / rect.width,
            y: (e.clientY - rect.top) / rect.height
          };
          controlChannel.send(JSON.stringify(ev));
          socket.emit("control-event", { roomId, event: ev });
        }
      });

      // --- Mouse click
      remoteV.addEventListener("mousedown", e => {
        if (controlChannel?.readyState === "open") {
          const rect = remoteV.getBoundingClientRect();
          const ev = {
            type: "click",
            x: (e.clientX - rect.left) / rect.width,
            y: (e.clientY - rect.top) / rect.height,
            button: e.button,
            double: e.detail === 2
          };
          controlChannel.send(JSON.stringify(ev));
          socket.emit("control-event", { roomId, event: ev });
        }
      });

      // --- Scroll
      remoteV.addEventListener("wheel", e => {
        if (controlChannel?.readyState === "open") {
          const ev = { type: "scroll", amount: e.deltaY };
          controlChannel.send(JSON.stringify(ev));
          socket.emit("control-event", { roomId, event: ev });
        }
      });
    }
  };
  return pc;
}

// --- Reset
function resetSharingUI(msg="Stopped") {
  if (screenStream) screenStream.getTracks().forEach(t=>t.stop());
  screenStream=null;
  localV.srcObject=null;
  remoteV.srcObject=null;
  shareBtn.disabled=false;
  stopBtn.disabled=true;
  joinBtn.disabled=false;
  setStatus(msg);
  if(pc){ pc.close(); pc=null; }
  controlChannel=null;
}

// --- Join Room
joinBtn.onclick = () => {
  if(!nameEl.value.trim()) return alert('Enter name');
  roomId = roomEl.value.trim();
  if(!roomId) return alert('Enter room');

  // assign role
  role = "viewer";  // by default viewer
  socket.emit('join-room', { roomId, name: nameEl.value.trim(), role });

  joinBtn.disabled = true;
  shareBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Joined ' + roomId + " as " + role);
  ensurePC();
};

// --- Events
socket.on('room-full', () => alert('Room full (max 2)'));
socket.on('peer-joined', () => setStatus('Peer joined'));

// --- Request screen
shareBtn.onclick = () => {
  if(!roomId) return alert('Join a room first');
  socket.emit('request-screen', { roomId, from: socket.id });
};

// --- Incoming request
socket.on('screen-request', ({ from, name }) => {
  pendingRequesterId = from;
  permText.textContent = `${name} wants to view your screen`;
  permBox.style.display = 'block';
});

// --- Accept
acceptBtn.onclick = async () => {
  if(!pendingRequesterId) return;
  socket.emit('permission-response', { to: pendingRequesterId, accepted:true });
  permBox.style.display='none';
  hideInputs();

  try {
    role = "sharer"; // now sharer
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video:true,audio:false });
    localV.srcObject = screenStream;

    const pcInstance = ensurePC();
    controlChannel = pcInstance.createDataChannel("control");
    controlChannel.onopen = ()=>console.log("Sharer: control channel OPEN ✅");

    // --- Handle control messages
    controlChannel.onmessage = e => {
      try {
        const data = JSON.parse(e.data);

        if (data.type === "mousemove" || data.type === "click") {
          const viewportX = data.x * window.innerWidth;
          const viewportY = data.y * window.innerHeight;

          cursor.style.left = viewportX + "px";
          cursor.style.top = viewportY + "px";
          cursor.style.display = "block";

          if (data.type === "click") {
            cursor.style.background = "blue";
            setTimeout(() => cursor.style.background = "red", 300);

            const el = document.elementFromPoint(viewportX, viewportY);

            if (el) {
              if (el.id === "stopBtn") {
                el.click();
              } else {
                socket.emit("control-event", { roomId, event: data });
              }
            }
          }
        }

        if (data.type === "keydown" || data.type === "keyup" || data.type === "scroll") {
          socket.emit("control-event", { roomId, event: data });
        }
      } catch(err){ console.error("Control error:", err); }
    };

    screenStream.getTracks().forEach(track=>pcInstance.addTrack(track,screenStream));

    const offer = await pcInstance.createOffer();
    await pcInstance.setLocalDescription(offer);
    socket.emit('signal',{roomId,desc:pcInstance.localDescription});

    shareBtn.disabled=true;
    stopBtn.disabled=false;
    setStatus('Sharing your screen...');
  } catch(err){
    console.error(err);
    alert('Screen capture failed: '+err.message);
    resetSharingUI('');
  }
  pendingRequesterId = null;
};

// --- Reject
rejectBtn.onclick = ()=>{
  if(!pendingRequesterId) return;
  socket.emit('permission-response',{to: pendingRequesterId, accepted:false});
  permBox.style.display='none';
  pendingRequesterId=null;
  shareBtn.disabled=false;
};

// --- Permission result
socket.on('permission-result',accepted=>{
  if(accepted){
    setStatus('Peer accepted. Waiting for connection…');
    hideInputs();
    ensurePC();
    stopBtn.disabled=false;
    shareBtn.disabled=true;
  } else {
    setStatus('Peer rejected your request.');
    shareBtn.disabled=false;
  }
});

// --- Signaling
socket.on('signal', async ({desc,candidate})=>{
  try{
    const pcInstance = ensurePC();
    if(desc){
      if(desc.type==='offer'){
        await pcInstance.setRemoteDescription(desc);
        const answer = await pcInstance.createAnswer();
        await pcInstance.setLocalDescription(answer);
        socket.emit('signal',{roomId,desc:pcInstance.localDescription});
        setStatus('Connected. Viewing peer screen.');
      } else if(desc.type==='answer'){
        await pcInstance.setRemoteDescription(desc);
        setStatus('Connected. Viewing peer screen.');
      }
    } else if(candidate){
      await pcInstance.addIceCandidate(candidate);
    }
  }catch(e){console.error('Signal error:',e);}
});

// --- Stop sharing
function stopSharing(){
  socket.emit('stop-share',roomId);
  resetSharingUI('You stopped sharing');
}
stopBtn.onclick=stopSharing;
socket.on('remote-stopped',()=>resetSharingUI('Peer stopped sharing'));
socket.on('peer-left',()=>resetSharingUI('Peer left'));

// --- Fullscreen
fullscreenBtn.onclick = ()=>{
  if(!document.fullscreenElement) remoteV.requestFullscreen();
  else document.exitFullscreen();
};

window.addEventListener('beforeunload',()=>{
  if(roomId) socket.emit('stop-share',roomId);
});

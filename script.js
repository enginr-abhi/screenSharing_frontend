// * script.js *
// --- Setup ---
const socket = io("https://screensharing-test-backend.onrender.com", {
    transports: ["websocket"]
});

// --- DOM Elements ---
const nameInput = document.getElementById("name");
const roomInput = document.getElementById("room");
const joinBtn = document.getElementById("joinBtn");
const shareBtn = document.getElementById("shareBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const permBox = document.getElementById("perm");
const acceptBtn = document.getElementById("acceptBtn");
const rejectBtn = document.getElementById("rejectBtn");
const localVideo = document.getElementById("local"); // Still kept for User2's internal stream
const remoteCanvas = document.getElementById("remoteCanvas"); // NEW: Canvas for display
const fullscreenBtn = document.getElementById("fullscreenBtn");

let roomId;
let remoteImage = new Image(); // For drawing incoming JPEG frames
let canvasContext = remoteCanvas.getContext('2d');
let captureInfo = {}; // Stores Agent's screen resolution for scaling control inputs
let isViewer = false;
let agentIdToControl = null;

// Helper to replace window.confirm/alert
function showModal(message) {
    statusEl.textContent = `🚨 ${message}`;
    setTimeout(() => {
        if (statusEl.textContent.startsWith('🚨')) statusEl.textContent = '';
    }, 5000);
}

// ---- UI Hides and Helpers ----
function hideInputs() {
    // Hide inputs after joining
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
    if (!name || !roomId) return showModal("Enter name and room");

    isViewer = true; // This user is the viewer (User1)
    socket.emit("set-name", { name });
    socket.emit("join-room", { roomId, name, isAgent: false });
    hideInputs();
    statusEl.textContent = `✅ ${name} Joined ${roomId}`;
};

// ---- Request screen (User1) ----
shareBtn.onclick = () => {
    // Viewer sends a request to the room. The Agent (User2) will receive this.
    socket.emit("request-screen", { roomId, from: socket.id });
    statusEl.textContent = "⏳ Requesting screen...";
};

// ---- Stop (User1) ----
stopBtn.onclick = () => {
    // Viewer can signal to stop sharing
    const name = nameInput.value.trim();
    socket.emit("stop-share", { roomId, name });
    
    // Clear canvas and reset UI
    canvasContext.clearRect(0, 0, remoteCanvas.width, remoteCanvas.height);
    remoteCanvas.style.backgroundColor = 'black';
    statusEl.textContent = "🛑 Stopped";
    stopBtn.disabled = true;
    shareBtn.disabled = false;
    agentIdToControl = null;
    disableRemoteControl();
};

// ---- Incoming screen request (User2 - Agent) ----
socket.on("screen-request", ({ from, name }) => {
    // NOTE: This logic assumes the Agent app is already running or about to be downloaded.
    // User2's browser (where this code is running) is now just the permission UI.
    
    permBox.classList.add("show");
    document.getElementById("permText").textContent = `${name} wants to view your screen`;

    acceptBtn.onclick = async () => {
        permBox.classList.remove("show");
        
        // --- Agent Download Warning (VNC/RDP requirement) ---
        // Since sharing is now ONLY done by Agent.exe, prompt User2 to run it.
        // We cannot use confirm(), so we give a prompt message.
        showModal("⚠️ Please ensure the 'remote-agent.exe' is running on this machine to start sharing.");
        
        // This user is the sharer/agent (User2)
        isViewer = false;

        // **IMPORTANT:** Since the AGENT.EXE handles screen sharing, we DO NOT 
        // need `navigator.mediaDevices.getDisplayMedia` here anymore.
        // We only send the acceptance response.
        
        // Tell the server/viewer that permission is granted
        socket.emit("permission-response", { to: from, accepted: true });
        stopBtn.disabled = false;
        shareBtn.disabled = true;
    };

    rejectBtn.onclick = () => {
        permBox.classList.remove("show");
        socket.emit("permission-response", { to: from, accepted: false });
    };
});


// ---- Permission result (User1 - Viewer) ----
socket.on("permission-result", accepted => {
    if (!accepted) {
        statusEl.textContent = "❌ Request denied";
        return;
    }
    statusEl.textContent = "✅ Request accepted. Waiting for Agent stream...";

    stopBtn.disabled = false;
    shareBtn.disabled = true;
});


// ==========================================================
// --- NEW VNC CLIENT STREAMING LOGIC ---
// ==========================================================

// NEW: Event received when permission is accepted and Agent is starting its stream
socket.on("stream-start", ({ agentId, roomId }) => {
    agentIdToControl = agentId;
    statusEl.textContent = `✅ Stream starting from Agent ${agentId.substring(0, 4)}...`;
    
    // Start listening for control events
    if (isViewer) {
        enableRemoteControl();
    }
});


// NEW: Event to draw the incoming JPEG frame onto the canvas
socket.on("screen-stream", ({ data }) => {
    if (!isViewer || !data) return;

    // Data is a binary JPEG buffer (ArrayBuffer)
    // Convert ArrayBuffer to Blob, then to Data URL
    const blob = new Blob([data], { type: 'image/jpeg' });
    const imageUrl = URL.createObjectURL(blob);

    remoteImage.onload = () => {
        // Set canvas resolution to match the received image resolution
        remoteCanvas.width = remoteImage.naturalWidth;
        remoteCanvas.height = remoteImage.naturalHeight;

        // Draw the image onto the canvas
        canvasContext.drawImage(remoteImage, 0, 0, remoteCanvas.width, remoteCanvas.height);
        
        // Clean up the URL to prevent memory leak
        URL.revokeObjectURL(imageUrl);
    };
    
    // Set the source of the Image object to trigger onload
    remoteImage.src = imageUrl;
});


// NEW: Event received from Agent with its resolution (for scaling control inputs)
socket.on("capture-info", info => {
    captureInfo = info;
    console.log("Agent Capture Info:", captureInfo);
});


// ---- Stop-share ----
socket.on("stop-share", ({ name }) => {
    // Clear canvas and reset UI
    canvasContext.clearRect(0, 0, remoteCanvas.width, remoteCanvas.height);
    remoteCanvas.style.backgroundColor = 'black';
    statusEl.textContent = `🛑 ${name} stopped sharing`;
    stopBtn.disabled = true;
    shareBtn.disabled = false;
    agentIdToControl = null;
    
    if (isViewer) disableRemoteControl();
});

// REMOVED: All WebRTC signaling (pc, desc, candidate)

// ---- Remote Control ----

// Helper to disable control listeners
function disableRemoteControl() {
    remoteCanvas.removeEventListener("mousemove", handleMouseMove);
    remoteCanvas.removeEventListener("click", handleClick);
    remoteCanvas.removeEventListener("dblclick", handleDblClick);
    remoteCanvas.removeEventListener("mousedown", handleMouseDown);
    remoteCanvas.removeEventListener("mouseup", handleMouseUp);
    remoteCanvas.removeEventListener("wheel", handleWheel);
    document.removeEventListener("keydown", handleKeyDown);
    document.removeEventListener("keyup", handleKeyUp);
}

// Global handler functions for cleanup
function getRelativeCoords(e) {
    const rect = remoteCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x, y };
}

function handleMouseMove(e) {
    const { x, y } = getRelativeCoords(e);
    socket.emit("control", { type: "mousemove", x, y });
}
function handleClick(e) {
    socket.emit("control", { type: "click", button: e.button });
}
function handleDblClick(e) {
    socket.emit("control", { type: "dblclick", button: e.button });
}
function handleMouseDown(e) {
    remoteCanvas.focus(); // Ensure canvas has focus for better key handling
    socket.emit("control", { type: "mousedown", button: e.button });
}
function handleMouseUp(e) {
    socket.emit("control", { type: "mouseup", button: e.button });
}
function handleWheel(e) {
    socket.emit("control", { type: "wheel", deltaY: e.deltaY });
}
function handleKeyDown(e) {
    socket.emit("control", { type: "keydown", key: e.key });
}
function handleKeyUp(e) {
    socket.emit("control", { type: "keyup", key: e.key });
}


function enableRemoteControl() {
    // Attach listeners to the canvas element
    remoteCanvas.addEventListener("mousemove", handleMouseMove);
    
    // Prevent default right-click context menu on canvas
    remoteCanvas.addEventListener('contextmenu', e => e.preventDefault());
    
    // Attach all other mouse listeners
    ["click", "dblclick", "mousedown", "mouseup"].forEach(evt => {
        remoteCanvas.addEventListener(evt, (e) => {
            // Only capture events if the target is the canvas itself
            if (e.target === remoteCanvas) {
                // We send coordinates with the mouse event to make sure cursor 
                // is correctly synchronized before the action.
                const { x, y } = getRelativeCoords(e);
                socket.emit("control", { type: evt, button: e.button, x, y });
            }
        });
    });

    remoteCanvas.addEventListener("wheel", handleWheel);

    // Keyboard events must be on the document to capture all keys
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    
    statusEl.textContent += " | Control Enabled";
}


// ---- Fullscreen Button ----
fullscreenBtn.onclick = () => {
    const remoteWrapper = document.querySelector(".remote-wrapper");
    // Request fullscreen on the canvas wrapper
    if (remoteWrapper.requestFullscreen) remoteWrapper.requestFullscreen();
};
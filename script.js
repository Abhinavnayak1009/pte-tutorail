let mediaRecorder;
let audioChunks = [];
let audioURL;
let stream;

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const playBtn = document.getElementById("playBtn");
const status = document.getElementById("status");
const audioPlayback = document.getElementById("audioPlayback");

startBtn.addEventListener("click", async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);

    audioChunks = [];
    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
      audioURL = URL.createObjectURL(audioBlob);
      audioPlayback.src = audioURL;
      playBtn.disabled = false;
    };

    mediaRecorder.start();
    status.textContent = "Recording... 🎙️";
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } catch (error) {
    console.error("Microphone access denied:", error);
    status.textContent = "Microphone access denied ❌";
  }
});

stopBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    stream.getTracks().forEach(track => track.stop());
    status.textContent = "Recording stopped.";
  }
  startBtn.disabled = false;
  stopBtn.disabled = true;
});

playBtn.addEventListener("click", () => {
  if (audioURL) {
    audioPlayback.play();
    status.textContent = "Playing recording ▶️";
  }
});

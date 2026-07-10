import { state } from './state.js';

export function initVoiceInput() {
  const mobileMicBtn = document.getElementById('mobileMicBtn');
  const mobileCommandInput = document.getElementById('mobileCommandInput');
  if (!mobileMicBtn || !mobileCommandInput) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  
  if (!SpeechRecognition) {
    mobileMicBtn.style.display = 'none';
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;
  
  let isListening = false;
  let wantsListening = false;
  
  recognition.onstart = () => {
    isListening = true;
    mobileMicBtn.classList.add('listening');
    mobileCommandInput.placeholder = '正在听取指令... 请说话...';
  };
  
  recognition.onend = () => {
    isListening = false;
    wantsListening = false;
    mobileMicBtn.classList.remove('listening');
    mobileCommandInput.placeholder = 'Type or dictate command...';
  };
  
  recognition.onresult = (event) => {
    if (!wantsListening) return;
    
    const transcript = Array.from(event.results)
      .map(result => result[0])
      .map(result => result.transcript)
      .join('');
    
    mobileCommandInput.value = transcript;
  };
  
  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    isListening = false;
    wantsListening = false;
    try {
      recognition.stop();
    } catch(e) {}
  };

  const startListening = () => {
    if (!isListening) {
      try {
        recognition.start();
      } catch (err) {
        console.warn('SpeechRecognition start error:', err);
      }
    }
  };

  const stopListening = () => {
    try {
      recognition.stop();
    } catch (err) {
      console.warn('SpeechRecognition stop error:', err);
    }
  };

  state.stopVoiceInputGlobal = () => {
    if (wantsListening) {
      wantsListening = false;
      stopListening();
    }
  };

  let lastTouchTime = 0;
  const handleMicToggle = (e) => {
    e.preventDefault();
    
    const now = Date.now();
    if (now - lastTouchTime < 300) return;
    if (e.type === 'touchstart') {
      lastTouchTime = now;
    }

    if (wantsListening) {
      wantsListening = false;
      stopListening();
    } else {
      wantsListening = true;
      startListening();
    }
  };

  mobileMicBtn.addEventListener('touchstart', handleMicToggle, { passive: false });
  mobileMicBtn.addEventListener('click', handleMicToggle);
}
export function stopVoiceInput() {
  if (state.stopVoiceInputGlobal) {
    state.stopVoiceInputGlobal();
  }
}

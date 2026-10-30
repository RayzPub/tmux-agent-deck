import { state } from './state.js';

let sharedRecognition = null;
let isListening = false;
let wantsListening = false;
let activeTarget = 'mobile'; // 'mobile' | 'chat'

function getOrCreateRecognition() {
  if (sharedRecognition) return sharedRecognition;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onstart = () => {
    isListening = true;
    if (activeTarget === 'chat') {
      const chatMic = document.getElementById('chatMicBtn');
      const chatInput = document.getElementById('chatComposerTextarea');
      if (chatMic) chatMic.classList.add('listening');
      if (chatInput) chatInput.placeholder = '正在听取语音... 请口述消息...';
    } else {
      const mobileMic = document.getElementById('mobileMicBtn');
      const mobileInput = document.getElementById('mobileCommandInput');
      if (mobileMic) mobileMic.classList.add('listening');
      if (mobileInput) mobileInput.placeholder = '正在听取指令... 请说话...';
    }
  };

  recognition.onend = () => {
    isListening = false;
    wantsListening = false;
    const chatMic = document.getElementById('chatMicBtn');
    const chatInput = document.getElementById('chatComposerTextarea');
    if (chatMic) chatMic.classList.remove('listening');
    if (chatInput) chatInput.placeholder = '输入消息，可添加/粘贴图片文件，输入 / 呼出指令...';

    const mobileMic = document.getElementById('mobileMicBtn');
    const mobileInput = document.getElementById('mobileCommandInput');
    if (mobileMic) mobileMic.classList.remove('listening');
    if (mobileInput) mobileInput.placeholder = '请输入或口述命令...';
  };

  recognition.onresult = (event) => {
    if (!wantsListening) return;

    const transcript = Array.from(event.results)
      .map(result => result[0])
      .map(result => result.transcript)
      .join('');

    if (activeTarget === 'chat') {
      const chatInput = document.getElementById('chatComposerTextarea');
      if (chatInput) {
        chatInput.value = transcript;
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      const mobileInput = document.getElementById('mobileCommandInput');
      if (mobileInput) {
        mobileInput.value = transcript;
        mobileInput.dispatchEvent(new Event('input', { bubbles: true }));
        mobileInput.scrollTop = mobileInput.scrollHeight;
      }
    }
  };

  recognition.onerror = (event) => {
    console.warn('Speech recognition notice/error:', event.error);
    isListening = false;
    wantsListening = false;
    try {
      recognition.stop();
    } catch(e) {}
  };

  sharedRecognition = recognition;
  return sharedRecognition;
}

export function bindChatVoiceInput() {
  const chatMicBtn = document.getElementById('chatMicBtn');
  if (!chatMicBtn || chatMicBtn.dataset.voiceBound) return;
  chatMicBtn.dataset.voiceBound = 'true';

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    chatMicBtn.style.display = 'none';
    return;
  }

  let lastTouchTime = 0;
  const handleChatMicToggle = (e) => {
    e.preventDefault();
    e.stopPropagation();

    const now = Date.now();
    if (now - lastTouchTime < 300) return;
    if (e.type === 'touchstart') lastTouchTime = now;

    const recognition = getOrCreateRecognition();
    if (!recognition) return;

    if (wantsListening && activeTarget === 'chat') {
      wantsListening = false;
      try { recognition.stop(); } catch (err) {}
    } else {
      activeTarget = 'chat';
      wantsListening = true;
      if (!isListening) {
        try { recognition.start(); } catch (err) {
          console.warn('Recognition start error:', err);
        }
      }
    }
  };

  chatMicBtn.addEventListener('touchstart', handleChatMicToggle, { passive: false });
  chatMicBtn.addEventListener('click', handleChatMicToggle);
}

export function initVoiceInput() {
  const mobileMicBtn = document.getElementById('mobileMicBtn');
  const mobileCommandInput = document.getElementById('mobileCommandInput');
  if (!mobileMicBtn || !mobileCommandInput) return;

  const recognition = getOrCreateRecognition();
  if (!recognition) {
    mobileMicBtn.style.display = 'none';
    return;
  }

  state.stopVoiceInputGlobal = () => {
    if (wantsListening) {
      wantsListening = false;
      try { recognition.stop(); } catch (err) {}
    }
  };

  let lastTouchTime = 0;
  const handleMobileMicToggle = (e) => {
    e.preventDefault();
    
    const now = Date.now();
    if (now - lastTouchTime < 300) return;
    if (e.type === 'touchstart') lastTouchTime = now;

    if (wantsListening && activeTarget === 'mobile') {
      wantsListening = false;
      try { recognition.stop(); } catch (err) {}
    } else {
      activeTarget = 'mobile';
      wantsListening = true;
      if (!isListening) {
        try { recognition.start(); } catch (err) {
          console.warn('Recognition start error:', err);
        }
      }
    }
  };

  mobileMicBtn.addEventListener('touchstart', handleMobileMicToggle, { passive: false });
  mobileMicBtn.addEventListener('click', handleMobileMicToggle);
}

export function stopVoiceInput() {
  if (state.stopVoiceInputGlobal) {
    state.stopVoiceInputGlobal();
  }
}

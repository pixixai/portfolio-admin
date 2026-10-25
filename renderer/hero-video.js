// Two media elements keep the outgoing frame visible until the next is decoded.
export function initHeroVideo({ reducedMotion, isBlocked = () => false }) {
  const hero = document.querySelector('.home-hero--video');
  const videos = [...(hero?.querySelectorAll('video') || [])];
  if (videos.length !== 2) return () => {};
  const finalImage = hero.querySelector('.hero-final');
  let slide = hero.querySelector('.hero-slide');
  const configURL = new URL(hero.dataset.backgroundConfig, location.href);
  const root = new URL('../', configURL);
  let playlist = [], current = 0, active = -1, desired = -1, ready = false;
  let visible = true, suspended = false, userPaused = false, finished = false;
  let blocked = false, disposed = false, frameToken = 0;
  const pending = new Set(), failed = new Set();
  const images = new Map();
  let imageIndex = -1, imageTimer = null, imageRemaining = 0, imageStarted = 0;
  const allowed = () => ready && visible && !suspended && !document.hidden && !reducedMotion.matches && !isBlocked() && !userPaused && !finished;
  const state = value => { hero.dataset.playbackState = value; };
  videos.forEach(video => { video.muted = video.defaultMuted = true; video.loop = false; });
  function stop() {
    videos.forEach(video => { if (!video.paused) video.pause(); });
    if (imageTimer !== null) { clearTimeout(imageTimer); imageTimer = null; imageRemaining = Math.max(0, imageRemaining - (performance.now() - imageStarted)); }
  }
  function prepareImage(index) {
    if (images.has(index) || failed.has(index)) return images.get(index);
    const item = playlist[index]; if (!item || item.type !== 'image') return;
    const image = new Image(); image.className = 'hero-slide'; image.alt = '';
    images.set(index, image);
    image.onload = () => { if (!disposed && (index === current || reducedMotion.matches)) activity(); };
    image.onerror = () => { failed.add(index); if (!disposed && index === current && !finished) advance(current+1); };
    image.src = item.src; return image;
  }
  function displayImage(index) {
    const image = prepareImage(index); if (!image?.complete || !image.naturalWidth || !slide) return false;
    if (imageIndex !== index || slide !== image || !slide.classList.contains('is-active')) {
      if (slide !== image) { slide.replaceWith(image); slide = image; }
      slide.classList.add('is-active');
      videos.forEach(video => video.classList.remove('is-active'));
      hero.classList.add('is-video-ready'); hero.classList.remove('is-final-frame');
      imageIndex = index; imageRemaining = playlist[index].duration * 1000;
      for (const [key, old] of images) if (key !== index && key !== index+1) { old.onload = old.onerror = null; images.delete(key); }
    }
    return true;
  }
  function prepare(slot, index) {
    const item = playlist[index]; if (!item || reducedMotion.matches) return;
    if (item.type === 'image') { prepareImage(index); return; }
    const video = videos[slot];
    if (video.getAttribute('src') !== item.src) { video.src = item.src; video.dataset.playlistIndex = String(index); }
    video.defaultPlaybackRate = video.playbackRate = item.playbackRate;
  }
  function finish() {
    finished = true; desired = -1; stop(); state('finished');
    if (finalImage.getAttribute('src') && finalImage.complete && finalImage.naturalWidth) hero.classList.add('is-final-frame');
  }
  function reveal(slot) {
    if (disposed || desired !== slot || !allowed()) return;
    const previous = active; active = slot;
    videos.forEach((video, index) => video.classList.toggle('is-active', index === slot));
    slide?.classList.remove('is-active');
    if (previous >= 0 && previous !== slot) videos[previous].pause();
    hero.classList.add('is-video-ready'); hero.classList.remove('is-final-frame'); state('playing');
    prepare(1-slot, current+1);
  }
  function onPlaying(event) {
    const slot = videos.indexOf(event.target);
    if (slot !== desired || !allowed()) { event.target.pause(); return; }
    event.target.playbackRate = playlist[current].playbackRate;
    const token = ++frameToken;
    if (typeof event.target.requestVideoFrameCallback === 'function') {
      event.target.requestVideoFrameCallback(() => { if (token === frameToken) reveal(slot); });
    } else reveal(slot);
  }
  function activity() {
    if (disposed) return;
    if (reducedMotion.matches) {
      stop(); hero.classList.remove('is-video-ready','is-final-frame'); videos.forEach(v => v.classList.remove('is-active')); slide?.classList.remove('is-active');
      const still = playlist.findIndex(item => item.type === 'image');
      if (still >= 0 && !failed.has(still)) { displayImage(still); if (imageIndex === still) slide?.classList.add('is-active'); }
      state('poster'); return;
    }
    if (!allowed() || blocked) {
      stop();
      if (finished) {
        if (active >= 0 && !slide?.classList.contains('is-active')) { videos[active].classList.add('is-active'); hero.classList.add('is-video-ready'); }
        if (finalImage.complete && finalImage.naturalWidth && finalImage.getAttribute('src')) hero.classList.add('is-final-frame');
        state('finished');
      } else state(blocked ? 'blocked' : 'paused');
      return;
    }
    if (!playlist.length) { finish(); return; }
    if (playlist[current]?.type === 'image') {
      desired = -1; stop();
      if (!displayImage(current)) { state('loading'); return; }
      state('playing'); prepare(active < 0 ? 0 : 1-active, current+1);
      imageStarted = performance.now(); imageTimer = setTimeout(() => { imageTimer = null; imageRemaining = 0; if (allowed()) advance(current+1); }, imageRemaining);
      return;
    }
    if (desired < 0) desired = active >= 0 ? active : 0;
    prepare(desired, current);
    const video = videos[desired];
    if (pending.has(video) || !video.paused) return;
    pending.add(video);
    try {
      Promise.resolve(video.play()).catch(error => {
        if (error?.name !== 'AbortError' && allowed()) { blocked = true; state('blocked'); }
      }).finally(() => {
        pending.delete(video);
        if (allowed() && !blocked && video.paused) activity();
      });
    } catch { pending.delete(video); blocked = true; state('blocked'); }
  }
  function advance(index) {
    current = index;
    while (failed.has(current) && current < playlist.length) current++;
    if (current >= playlist.length) { finish(); return; }
    desired = active < 0 ? 0 : 1-active; blocked = false; activity();
  }
  function onEnded(event) { if (playlist[current]?.type !== 'image' && videos.indexOf(event.target) === active) advance(current+1); }
  function onError(event) {
    const index = Number(event.target.dataset.playlistIndex);
    failed.add(index);
    if (videos.indexOf(event.target) === desired) advance(current+1);
  }
  function toggle() {
    if (reducedMotion.matches || !ready || !playlist.length) return;
    if (finished) { finished = false; failed.clear(); current = 0; imageIndex = -1; desired = active < 0 ? 0 : 1-active; prepare(desired,0); if (playlist[0].type !== 'image') videos[desired].currentTime = 0; userPaused = false; }
    else userPaused = blocked ? false : !userPaused;
    blocked = false; activity();
  }
  function click(event) {
    if (event.target.closest('.home-title,.home-description,a,button,input,textarea,select,label')) return;
    toggle();
  }
  function key(event) {
    if (event.target === hero && [' ', 'Enter'].includes(event.key)) { event.preventDefault(); toggle(); }
  }
  const hide = () => { suspended = true; activity(); };
  const show = () => { suspended = false; activity(); };
  const onFinalLoad = () => { if (finished && !reducedMotion.matches) hero.classList.add('is-final-frame'); };
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { visible = entries[0].isIntersecting; activity(); }) : null;
  observer?.observe(hero);
  videos.forEach(video => { video.addEventListener('playing',onPlaying); video.addEventListener('ended',onEnded); video.addEventListener('error',onError); });
  finalImage.addEventListener('load',onFinalLoad);
  hero.addEventListener('click',click); hero.addEventListener('keydown',key);
  document.addEventListener('visibilitychange',activity);
  window.addEventListener('portfolio:overlaychange',activity);
  window.addEventListener('pagehide',hide); window.addEventListener('pageshow',show);
  reducedMotion.addEventListener('change',activity);
  const controller = new AbortController();
  const safeURL = value => { const url = new URL(value,root); return url.origin === location.origin && /^https?:$/.test(url.protocol) ? url.href : null; };
  async function configure() {
    let config;
    try { const response = await fetch(configURL,{signal:controller.signal}); if (!response.ok) throw new Error('Background unavailable'); config = await response.json(); }
    catch { config = {videos:[{src:new URL(videos[0].dataset.src,location.href).href,playbackRate:1}]}; }
    if (disposed) return;
    const shadeOpacity=Number.isFinite(config.shadeOpacity)?Math.min(100,Math.max(0,config.shadeOpacity)):80;
    hero.style.setProperty('--hero-shade-opacity',String(shadeOpacity/100));
    playlist = (Array.isArray(config.videos) ? config.videos : []).slice(0,30).filter(item=>item&&typeof item==='object').map(item => ({src:typeof item.src === 'string' ? safeURL(item.src) : null,type:item.type==='image'?'image':'video',duration:Math.min(120,Math.max(1,Number(item.duration)||5)),playbackRate:Math.min(4,Math.max(.25,Number(item.playbackRate)||1))})).filter(item=>item.src);
    if (typeof config.finalFrame === 'string') { const url = safeURL(config.finalFrame); if (url) finalImage.src = url; }
    ready = true; activity();
  }
  configure();
  return () => {
    disposed = true; controller.abort(); observer?.disconnect(); stop();
    images.forEach(image => { image.onload = image.onerror = null; }); images.clear();
    videos.forEach(video => { video.removeEventListener('playing',onPlaying); video.removeEventListener('ended',onEnded); video.removeEventListener('error',onError); });
    finalImage.removeEventListener('load',onFinalLoad); hero.removeEventListener('click',click); hero.removeEventListener('keydown',key);
    document.removeEventListener('visibilitychange',activity); window.removeEventListener('portfolio:overlaychange',activity);
    window.removeEventListener('pagehide',hide); window.removeEventListener('pageshow',show); reducedMotion.removeEventListener('change',activity);
  };
}

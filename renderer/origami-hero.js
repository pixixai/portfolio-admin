const clamp = value => Math.max(0, Math.min(1, value));

// Unit-width facets share their edge positions, so they remain joined while unfolding.
export function origamiPose(scroll = 0, hover = 0) {
  const openness = 1 - (1 - clamp(hover)) * (1 - .94 * clamp(scroll));
  const fold = 57 - 49 * openness;
  const panels = [];
  let x = 0, z = 0;
  for (let i = 0; i < 6; i++) {
    const angle = (i % 2 ? -1 : 1) * fold;
    panels.push({ x, z, angle });
    x += Math.cos(angle * Math.PI / 180);
    z -= Math.sin(angle * Math.PI / 180);
  }
  const minZ = Math.min(...panels.map(panel => panel.z), z);
  panels.forEach(panel => { panel.x -= x / 2; panel.z -= minZ / 2; });
  return { openness, fold, width: x, panels };
}

// Project the same CSS 3D facets into a flat sampling layer. Backdrop filters on
// nested 3D faces are inconsistent across compositors; these windows remain 2D.
export function projectOrigami(pose, { width, height, leaf, paperHeight, centerX = .44, perspective = 950 }, tiltX = 0, tiltY = 0, scroll = 0) {
  const radians = degrees => degrees * Math.PI / 180;
  const ax = radians(-14 + tiltX), ay = radians(-17 + tiltY + scroll * 14);
  const az = radians(-8 + pose.openness * 5 + tiltY * .16);
  return pose.panels.map(panel => [[0, 0], [leaf, 0], [leaf, paperHeight], [0, paperHeight]].map(([u, v]) => {
    const a = radians(panel.angle);
    let x = (panel.x * leaf + u * Math.cos(a)), y = v - paperHeight / 2;
    let z = panel.z * leaf - u * Math.sin(a);
    [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
    [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
    [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
    const scale = perspective / Math.max(perspective * .1, perspective - z);
    return { x: width / 2 + (x + width * (centerX - .5)) * scale, y: height / 2 + y * scale };
  }));
}

export function initOrigamiHero({ gsap, ScrollTrigger, reducedMotion, isBlocked, onSkip = () => {} }) {
  const hero = document.querySelector('.home-hero');
  const trigger = hero?.querySelector('.origami-trigger');
  if (!trigger) return () => {};
  const paper = trigger.querySelector('.origami-paper');
  const faces = [...paper.querySelectorAll('.paper-face')];
  const shell = hero.querySelector('.hero-shell');
  const backdrop = shell?.querySelector('.origami-backdrop');
  const projection = document.createElement('span');
  const samplingPad = 100;
  projection.className = 'glass-projection';
  projection.style.setProperty('--sampling-pad', `${samplingPad}px`);
  projection.setAttribute('aria-hidden', 'true');
  const samples = backdrop ? faces.map(() => {
    const window = document.createElement('span'), world = document.createElement('span');
    window.className = 'refraction-window';
    world.className = 'refraction-world';
    world.append(backdrop.cloneNode(true));
    window.append(world);
    projection.append(window);
    return { window, world };
  }) : [];
  trigger.prepend(projection);
  hero.classList.toggle('has-refraction', samples.length === 6);
  let metrics;
  const state = { scroll: 0, hover: 0, tiltX: 0, tiltY: 0 };
  let hovered = false, latched = false, suspended = false, active = false;
  let inView = false, scrollTween, hoverTween, pointerTween, observer;
  let rect = trigger.getBoundingClientRect();
  const hash = ['#works', '#contact'].includes(location.hash) ? location.hash : null;
  let initialTarget = hash || (new URL(location.href).searchParams.has('work') ? '#works' : null);

  function measure() {
    rect = trigger.getBoundingClientRect();
    const shellRect = shell?.getBoundingClientRect();
    const paperStyle = getComputedStyle(paper);
    const width = trigger.clientWidth || rect.width || 500;
    const left = paperStyle.left;
    metrics = {
      width, height: trigger.clientHeight || rect.height || 400,
      leaf: faces[0].offsetWidth || 72, paperHeight: paper.offsetHeight || 320,
      centerX: left.endsWith('%') ? parseFloat(left) / 100 : parseFloat(left) / width || (innerWidth <= 760 ? .48 : .44),
      perspective: parseFloat(getComputedStyle(trigger).perspective) || 950,
    };
    samples.forEach(({ world }) => {
      Object.assign(world.style, {
        left: `${(shellRect?.left || 0) - rect.left + samplingPad}px`, top: `${(shellRect?.top || 0) - rect.top + samplingPad}px`,
        width: `${shellRect?.width || width * 2}px`, height: `${shellRect?.height || metrics.height + 90}px`,
      });
    });
  }

  function render() {
    const pose = origamiPose(state.scroll, state.hover);
    faces.forEach((face, i) => {
      const panel = pose.panels[i];
      face.style.transform = `translate3d(calc(var(--leaf) * ${panel.x}), 0, calc(var(--leaf) * ${panel.z})) rotateY(${panel.angle}deg)`;
    });
    paper.style.transform = `translateY(-50%) rotateX(${-14 + state.tiltX}deg) rotateY(${-17 + state.tiltY + state.scroll * 14}deg) rotateZ(${-8 + pose.openness * 5 + state.tiltY * .16}deg)`;
    const polygons = projectOrigami(pose, metrics, state.tiltX, state.tiltY, state.scroll);
    samples.forEach(({ window, world }, i) => {
      window.style.clipPath = `polygon(${polygons[i].map(p => `${(p.x + samplingPad).toFixed(3)}px ${(p.y + samplingPad).toFixed(3)}px`).join(',')})`;
      const bend = Math.sin(pose.panels[i].angle * Math.PI / 180);
      world.style.transform = `translate3d(${(bend * 7).toFixed(3)}px, ${(bend * 2).toFixed(3)}px, 0) skewY(${(bend * 1.5).toFixed(3)}deg)`;
    });
    trigger.style.setProperty('--unfold', pose.openness.toFixed(4));
  }
  function animateHover() {
    const target = latched || hovered ? 1 : 0;
    hoverTween?.kill();
    if (!gsap || reducedMotion.matches || !active) {
      state.hover = target;
      render();
      return;
    }
    hoverTween = gsap.to(state, { hover: target, duration: target ? 1.15 : .95, ease: 'power3.out', onUpdate: render });
  }
  function clearPointer() {
    pointerTween?.kill();
    state.tiltX = state.tiltY = 0;
  }
  function activity() {
    active = !reducedMotion.matches && inView && !document.hidden && !isBlocked() && !suspended;
    hero.classList.toggle('is-ambient-active', active);
    if (!active) {
      hovered = false;
      hoverTween?.kill();
      clearPointer();
      state.hover = latched ? 1 : 0;
      render();
    }
  }
  function enter(event) {
    if (event.pointerType === 'touch' || !active) return;
    rect = trigger.getBoundingClientRect();
    hovered = true;
    animateHover();
  }
  function leave() {
    hovered = false;
    clearPointer();
    animateHover();
  }
  function move(event) {
    if (!active || event.pointerType === 'touch' || !gsap) return;
    const x = clamp((event.clientX - rect.left) / Math.max(1, rect.width));
    const y = clamp((event.clientY - rect.top) / Math.max(1, rect.height));
    pointerTween?.kill();
    pointerTween = gsap.to(state, { tiltX: (y - .5) * -24, tiltY: (x - .5) * 36, duration: .65, ease: 'power2.out', onUpdate: render });
  }
  function toggle() {
    latched = !latched;
    trigger.setAttribute('aria-pressed', String(latched));
    trigger.setAttribute('aria-label', latched ? '取消折纸展开锁定' : '展开并锁定玻璃折纸');
    animateHover();
  }
  function setup() {
    scrollTween?.scrollTrigger?.kill();
    scrollTween?.kill();
    hoverTween?.kill();
    clearPointer();
    observer?.disconnect();
    scrollTween = observer = null;
    hovered = false;
    state.scroll = 0;
    state.hover = latched ? 1 : 0;
    const bounds = hero.getBoundingClientRect();
    inView = bounds.bottom > 0 && bounds.top < innerHeight;
    if (!reducedMotion.matches) {
      observer = new IntersectionObserver(entries => { inView = entries[0].isIntersecting; activity(); });
      observer.observe(hero);
      if (gsap && ScrollTrigger) {
        gsap.registerPlugin(ScrollTrigger);
        scrollTween = gsap.fromTo(state, { scroll: 0 }, {
          scroll: 1, ease: 'none', onUpdate: render,
          scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: .35 },
        });
      } else {
        state.scroll = clamp(-bounds.top / Math.max(1, bounds.height));
      }
    }
    render();
    activity();
  }
  function scroll() {
    rect = trigger.getBoundingClientRect();
    if (!scrollTween && !reducedMotion.matches) {
      const bounds = hero.getBoundingClientRect();
      state.scroll = clamp(-bounds.top / Math.max(1, bounds.height));
      render();
    }
  }
  function layout() {
    scrollTween?.scrollTrigger?.refresh();
    if (!initialTarget) return;
    const target = document.querySelector(initialTarget);
    initialTarget = null;
    if (!target) return;
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY, behavior: 'instant' });
    ScrollTrigger?.update();
    if (scrollTween) {
      const st = scrollTween.scrollTrigger;
      scrollTween.progress(clamp((window.scrollY - st.start) / Math.max(1, st.end - st.start)));
      st.getTween()?.progress(1);
    } else scroll();
    onSkip(window.scrollY);
  }
  const resize = () => { measure(); render(); };
  const hide = () => { suspended = true; activity(); };
  const show = () => { suspended = false; scroll(); activity(); };
  measure();
  setup();
  const sizeObserver = new ResizeObserver(resize);
  sizeObserver.observe(trigger);
  sizeObserver.observe(shell);
  trigger.addEventListener('pointerenter', enter);
  trigger.addEventListener('pointerleave', leave);
  trigger.addEventListener('pointermove', move, { passive: true });
  trigger.addEventListener('click', toggle);
  window.addEventListener('scroll', scroll, { passive: true });
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('portfolio:layout', layout);
  window.addEventListener('portfolio:overlaychange', activity);
  document.addEventListener('visibilitychange', activity);
  reducedMotion.addEventListener('change', setup);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  return () => {
    sizeObserver.disconnect();
    observer?.disconnect();
    scrollTween?.scrollTrigger?.kill();
    scrollTween?.kill();
    hoverTween?.kill();
    pointerTween?.kill();
    trigger.removeEventListener('pointerenter', enter);
    trigger.removeEventListener('pointerleave', leave);
    trigger.removeEventListener('pointermove', move);
    trigger.removeEventListener('click', toggle);
    window.removeEventListener('scroll', scroll);
    window.removeEventListener('resize', resize);
    window.removeEventListener('portfolio:layout', layout);
    window.removeEventListener('portfolio:overlaychange', activity);
    document.removeEventListener('visibilitychange', activity);
    reducedMotion.removeEventListener('change', setup);
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
    hero.classList.remove('is-ambient-active');
    hero.classList.remove('has-refraction');
    projection.remove();
  };
}

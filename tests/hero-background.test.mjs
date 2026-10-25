import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {initHeroVideo} from '../renderer/hero-video.js';

async function fixture(t, config, reduced = false) {
  const w = new Window({url:'http://127.0.0.1/site/'});
  t.after(()=>w.happyDOM.abort());
  w.document.body.innerHTML = '<section class="home-hero--video" data-background-config="data/home-background.json"><div class="hero-image"><video data-src="assets/default.mp4"></video><video></video><img class="hero-slide"><img class="hero-final"></div></section>';
  const hero=w.document.querySelector('section'), videos=[...hero.querySelectorAll('video')], loaded=[], timers=new Map(), paused=new WeakMap();
  let now=0, timerId=0;
  w.performance.now=()=>now;
  w.setTimeout=(fn,ms)=>{const id=++timerId;timers.set(id,{fn,at:now+ms});return id;};w.clearTimeout=id=>timers.delete(id);
  const tick=ms=>{now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}};
  for(const video of videos){paused.set(video,true);Object.defineProperty(video,'paused',{get:()=>paused.get(video)});video.play=()=>{paused.set(video,false);video.dispatchEvent(new w.Event('playing'));return Promise.resolve();};video.pause=()=>paused.set(video,true);}
  const NativeImage=w.Image;w.Image=function(){const image=new NativeImage();loaded.push(image);return image;};
  w.fetch=async()=>({ok:true,json:async()=>config});
  const mediaQuery=new w.EventTarget();mediaQuery.matches=reduced;
  const dispose=w.eval(`(${initHeroVideo.toString()})`)({reducedMotion:mediaQuery});t.after(dispose);
  await new Promise(setImmediate);
  const load=image=>{assert.ok(image);Object.defineProperties(image,{complete:{value:true,configurable:true},naturalWidth:{value:1920,configurable:true}});image.dispatchEvent(new w.Event('load'));};
  return {w,hero,videos,loaded,timers,tick,load,dispose,mediaQuery,click:()=>hero.dispatchEvent(new w.MouseEvent('click',{bubbles:true}))};
}

test('图片、视频混合播放按序切换，图片暂停保留剩余时长，末项保留并可重播',async t=>{
  const f=await fixture(t,{videos:[{src:'a.png',type:'image',duration:5},{src:'b.mp4',playbackRate:2},{src:'c.png',type:'image',duration:3}]});
  assert.equal(f.hero.dataset.playbackState,'loading');assert.ok(f.videos.every(video=>video.paused));
  f.load(f.loaded[0]);assert.equal(f.hero.querySelector('.hero-slide.is-active').src,'http://127.0.0.1/site/a.png');
  f.tick(2000);f.click();assert.equal(f.hero.dataset.playbackState,'paused');assert.equal(f.timers.size,0);
  f.tick(20000);assert.ok(f.hero.querySelector('.hero-slide.is-active'));f.click();f.tick(2999);assert.ok(f.hero.querySelector('.hero-slide.is-active'));
  f.tick(1);assert.ok(f.videos[0].classList.contains('is-active'));assert.equal(f.videos[0].playbackRate,2);
  f.videos[0].dispatchEvent(new f.w.Event('ended'));assert.equal(f.hero.dataset.playbackState,'loading');assert.ok(f.videos[0].classList.contains('is-active'),'下一张图片就绪前保留上一画面');
  f.load(f.loaded[1]);assert.ok(!f.videos[0].classList.contains('is-active'));assert.equal(f.hero.querySelector('.hero-slide.is-active').src,'http://127.0.0.1/site/c.png');
  f.tick(3000);assert.equal(f.hero.dataset.playbackState,'finished');assert.ok(f.hero.querySelector('.hero-slide.is-active'),'结束后保留最后图片');
  f.click();f.load(f.loaded.at(-1));assert.equal(f.hero.querySelector('.hero-slide.is-active').src,'http://127.0.0.1/site/a.png');f.dispose();assert.equal(f.timers.size,0);
});

test('图片序列结束使用定格图，切后台暂停计时，返回后继续',async t=>{
  const f=await fixture(t,{videos:[{src:'a.png',type:'image',duration:2}],finalFrame:'final.png'});
  f.load(f.hero.querySelector('.hero-final'));f.load(f.loaded[0]);f.tick(500);
  Object.defineProperty(f.w.document,'hidden',{value:true,configurable:true});f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));assert.equal(f.timers.size,0);
  f.tick(10000);Object.defineProperty(f.w.document,'hidden',{value:false,configurable:true});f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));f.tick(1499);assert.equal(f.hero.dataset.playbackState,'playing');
  f.tick(1);assert.equal(f.hero.dataset.playbackState,'finished');assert.ok(f.hero.classList.contains('is-final-frame'));
  f.click();assert.ok(!f.hero.classList.contains('is-final-frame'));assert.equal(f.hero.dataset.playbackState,'playing');assert.ok(f.hero.querySelector('.hero-slide.is-active'));
});

test('图片失败跳过，旧的纯视频配置继续按倍速播放与定格',async t=>{
  const f=await fixture(t,{videos:[{src:'bad.png',type:'image',duration:1},{src:'one.mp4',playbackRate:.5},{src:'two.mp4',playbackRate:1.5}]});
  f.loaded[0].dispatchEvent(new f.w.Event('error'));assert.ok(f.videos[0].classList.contains('is-active'));assert.equal(f.videos[0].playbackRate,.5);
  f.videos[0].dispatchEvent(new f.w.Event('ended'));assert.ok(f.videos[1].classList.contains('is-active'));assert.equal(f.videos[1].playbackRate,1.5);
  f.videos[1].dispatchEvent(new f.w.Event('ended'));assert.equal(f.hero.dataset.playbackState,'finished');assert.ok(f.videos[1].classList.contains('is-active'));
});

test('减少动态效果时使用静态图片，不加载或播放视频、不启动计时',async t=>{
  const f=await fixture(t,{videos:[{src:'one.mp4',playbackRate:1},{src:'still.png',type:'image',duration:5}]},true);
  f.load(f.loaded[0]);assert.ok(f.videos.every(video=>!video.getAttribute('src')&&video.paused));assert.equal(f.timers.size,0);assert.equal(f.hero.dataset.playbackState,'poster');assert.ok(f.hero.querySelector('.hero-slide.is-active'));
  f.mediaQuery.matches=false;f.mediaQuery.dispatchEvent(new f.w.Event('change'));assert.ok(f.videos[0].classList.contains('is-active'));f.videos[0].dispatchEvent(new f.w.Event('ended'));assert.ok(f.hero.querySelector('.hero-slide.is-active'),'恢复动态后仍能显示曾作为静态背景的同一图片');assert.equal(f.timers.size,1);
});

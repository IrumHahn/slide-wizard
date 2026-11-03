// video-runtime.mjs — 발표 중 영상을 다루는 장치 한 벌.
//
//  왜 여기 한 곳에 있나:
//    덱 8개는 각자 다른 발표 스크립트를 품고 있다. 영상 장치를 덱마다 손으로
//    넣으면 고칠 때마다 8곳을 고쳐야 한다. 여기 한 벌만 두고, 덱을 저장할 때
//    서버가 갈아 끼운다.
//
//  어디에 꽂나:
//    무대(<main class="deck-stage">) **바깥**, </body> 바로 앞.
//    deck-io.mjs 는 무대 안쪽만 교체하므로 편집기 저장과 부딪히지 않는다.
//
//  버전을 올리면 다음 저장 때 모든 덱이 새 장치로 바뀐다.

export const VIDEO_RUNTIME_VERSION = 1;

const OPEN = `<!-- pe-video-runtime v${VIDEO_RUNTIME_VERSION} -->`;
const CLOSE = "<!-- /pe-video-runtime -->";

/** 주입된 블록을 통째로 찾아내는 자 (버전이 달라도 잡는다) */
const BLOCK_RE = /[ \t]*<!-- pe-video-runtime v\d+ -->[\s\S]*?<!-- \/pe-video-runtime -->\n?/g;

/* ═══════════════════════════════════════════════════════════
   발표 장치 — 이 문자열이 덱 안에서 그대로 돈다
   ═══════════════════════════════════════════════════════════ */
const RUNTIME_JS = String.raw`
(function(){
  if (window.__PE_VIDEO) return;          /* 두 번 꽂혀도 한 번만 */
  window.__PE_VIDEO = true;

  /* ── 발표 중에만 쓰는 옷. 편집기는 자기 옷을 따로 입는다. */
  var CSS = [
    '.pe-slot>video{display:block;width:100%;height:100%;object-fit:cover;object-position:center;background:#0b0b09}',
    '.pe-slot[data-fit="contain"]>video{object-fit:contain}',

    /* 인트로 — 영상이 먼저, 글은 나중 */
    '.pe-imgzone[data-pos="cinema"]{left:0;top:0;width:1920px;height:1080px;z-index:0;gap:0}',
    '.pe-imgzone[data-pos="cinema"] .pe-slot{border:0;background:#0b0b09}',
    '.slide[data-pe-img="cinema"]>:not(.pe-imgzone){z-index:2}',
    '.pe-imgzone[data-pos="cinema"]::after{content:"";position:absolute;inset:0;z-index:1;opacity:1;',
      'transition:opacity 1.1s cubic-bezier(.22,1,.36,1);',
      'background:linear-gradient(90deg,rgba(11,11,9,.80) 0%,rgba(11,11,9,.42) 58%,rgba(11,11,9,.14) 100%)}',
    /* 기다리는 동안: 어둠도 글도 없다 — 영상만 */
    '.slide.pe-cine-wait .pe-imgzone[data-pos="cinema"]::after{opacity:0}',
    '.slide.pe-cine-wait>:not(.pe-imgzone){opacity:0!important;transition:opacity .5s ease}',
    '.slide.pe-cine-wait .reveal{opacity:0!important;transform:translateY(20px)!important}',

    /* 호버 컨트롤 */
    '.pe-vbar{position:absolute;left:0;right:0;bottom:0;z-index:9;display:flex;align-items:center;gap:14px;',
      'padding:26px 28px 20px;opacity:0;transform:translateY(10px);pointer-events:none;',
      'transition:opacity .22s ease,transform .22s ease;font-family:Pretendard,-apple-system,sans-serif;',
      'background:linear-gradient(to top,rgba(11,11,9,.78),rgba(11,11,9,0))}',
    '.pe-vslot.pe-vshow .pe-vbar{opacity:1;transform:none;pointer-events:auto}',
    '.pe-vbar button{flex:0 0 auto;width:44px;height:44px;border:0;border-radius:50%;cursor:pointer;',
      'background:rgba(255,255,255,.14);color:#fff;font-size:19px;line-height:1;display:flex;',
      'align-items:center;justify-content:center;backdrop-filter:blur(6px);transition:background .15s}',
    '.pe-vbar button:hover{background:rgba(255,255,255,.30)}',
    '.pe-vbar .pe-vseek{flex:1 1 auto;height:34px;display:flex;align-items:center;cursor:pointer}',
    '.pe-vbar .pe-vtrack{width:100%;height:5px;border-radius:3px;background:rgba(255,255,255,.26);overflow:hidden}',
    '.pe-vbar .pe-vfill{height:100%;width:0;background:#fff;border-radius:3px}',
    '.pe-vbar .pe-vtime{flex:0 0 auto;color:rgba(255,255,255,.88);font-size:16px;font-weight:500;',
      'font-variant-numeric:tabular-nums;letter-spacing:.02em}',

    /* 소리를 켠 순간 잠깐 뜨는 알림 */
    '.pe-vtoast{position:fixed;left:50%;bottom:56px;transform:translateX(-50%) translateY(8px);z-index:99999;',
      'background:rgba(11,11,9,.88);color:#fff;padding:12px 20px;border-radius:999px;font-size:15px;',
      'font-weight:600;font-family:Pretendard,-apple-system,sans-serif;opacity:0;pointer-events:none;',
      'transition:opacity .2s ease,transform .2s ease;backdrop-filter:blur(8px)}',
    '.pe-vtoast.on{opacity:1;transform:translateX(-50%)}',

    /* 인쇄(PDF) — 영상은 안 찍힌다. 잡아 둔 첫 화면이 자리를 대신한다. */
    '@media print{.pe-vbar{display:none!important}',
      '.pe-slot>video{display:none!important}',
      '.pe-vslot[data-poster]{background-size:cover;background-position:center}',
      '.slide.pe-cine-wait>:not(.pe-imgzone){opacity:1!important}',
      '.slide.pe-cine-wait .reveal{opacity:1!important;transform:none!important}',
      '.slide.pe-cine-wait .pe-imgzone[data-pos="cinema"]::after{opacity:1}}'
  ].join('\n');

  var st = document.createElement('style');
  st.id = 'pe-video-css';
  st.textContent = CSS;
  document.head.appendChild(st);

  var cineTimer = null;

  /* ── 소리는 발표 하나 동안 기억한다.
        한 번 켠 사람이 장마다 다시 누르게 하지 않는다. */
  if (typeof window.__DECK_SOUND !== 'boolean') window.__DECK_SOUND = false;

  var mmss = function(t){
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  };

  var toastEl = null, toastTimer = null;
  function toast(msg){
    if (!toastEl){
      toastEl = document.createElement('div');
      toastEl.className = 'pe-vtoast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('on'); }, 1500);
  }

  /* ═══ 슬롯 하나 ═══ */
  function setup(slot){
    if (slot.__peReady) return;
    var v = slot.querySelector('video');
    if (!v) return;
    slot.__peReady = true;
    slot.classList.add('pe-vslot');

    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.muted = true;                        /* 소리 있는 자동재생은 브라우저가 막는다 */
    v.loop = slot.dataset.loop !== '0';
    v.preload = 'auto';
    if (slot.dataset.poster) slot.style.backgroundImage = 'url("' + slot.dataset.poster + '")';

    /* 컨트롤 */
    var bar = document.createElement('div');
    bar.className = 'pe-vbar';
    bar.innerHTML =
      '<button data-a="play" title="재생 / 멈춤">▶</button>' +
      '<button data-a="restart" title="처음부터">↺</button>' +
      '<div class="pe-vseek"><div class="pe-vtrack"><div class="pe-vfill"></div></div></div>' +
      '<div class="pe-vtime">0:00</div>' +
      '<button data-a="sound" title="소리">🔇</button>';
    slot.appendChild(bar);

    var bPlay  = bar.querySelector('[data-a="play"]');
    var bSound = bar.querySelector('[data-a="sound"]');
    var seek   = bar.querySelector('.pe-vseek');
    var fill   = bar.querySelector('.pe-vfill');
    var time   = bar.querySelector('.pe-vtime');

    function paint(){
      bPlay.textContent = v.paused ? '▶' : '❚❚';
      bSound.textContent = v.muted ? '🔇' : '🔊';
      var d = v.duration;
      fill.style.width = (isFinite(d) && d > 0 ? (v.currentTime / d) * 100 : 0) + '%';
      time.textContent = mmss(v.currentTime) + (isFinite(d) && d > 0 ? ' / ' + mmss(d) : '');
    }
    v.addEventListener('timeupdate', paint);
    v.addEventListener('loadedmetadata', paint);
    v.addEventListener('play', paint);
    v.addEventListener('pause', paint);

    bar.addEventListener('click', function(e){
      var a = e.target.closest('button') && e.target.closest('button').dataset.a;
      if (!a) return;
      e.stopPropagation();
      if (a === 'play'){ v.paused ? v.play().catch(function(){}) : v.pause(); }
      if (a === 'restart'){ v.currentTime = 0; v.play().catch(function(){}); }
      if (a === 'sound'){
        window.__DECK_SOUND = v.muted;
        applySound();
        toast(window.__DECK_SOUND ? '🔊 소리 켬' : '🔇 소리 끔');
      }
      paint();
    });

    /* 진행바를 끌어 탐색 */
    function scrub(e){
      var r = seek.getBoundingClientRect();
      var p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (isFinite(v.duration)) v.currentTime = p * v.duration;
      paint();
    }
    seek.addEventListener('mousedown', function(e){
      e.stopPropagation(); e.preventDefault(); scrub(e);
      var move = function(ev){ scrub(ev); };
      var up = function(){ document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    /* 마우스를 올리면 뜨고, 2초 가만있으면 사라진다 */
    var hideTimer = null;
    function wake(){
      slot.classList.add('pe-vshow');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function(){ slot.classList.remove('pe-vshow'); }, 2000);
    }
    slot.addEventListener('mousemove', wake);
    slot.addEventListener('mouseenter', wake);
    slot.addEventListener('mouseleave', function(){ clearTimeout(hideTimer); slot.classList.remove('pe-vshow'); });

    /* 영상을 누르면 재생/멈춤 — 컨트롤을 안 써도 된다 */
    v.addEventListener('click', function(e){
      if (document.body.classList.contains('editing') || window.__DECK_EDIT_MODE) return;
      e.stopPropagation();
      v.paused ? v.play().catch(function(){}) : v.pause();
    });

    paint();
  }

  function applySound(){
    document.querySelectorAll('.pe-vslot video').forEach(function(v){
      var slot = v.closest('.pe-vslot');
      var wants = slot && slot.dataset.sound === '1';
      /* 이 장이 소리를 원하지 않으면 계속 음소거. 원하면 발표 전체 설정을 따른다. */
      v.muted = !(wants && window.__DECK_SOUND);
    });
  }

  /* ═══ 장이 바뀔 때 ═══ */
  function leave(slide){
    slide.classList.remove('pe-cine-wait');
    slide.querySelectorAll('.pe-vslot video').forEach(function(v){
      v.pause();
      try { v.currentTime = 0; } catch(e){}     /* 되감아 둔다 — 다음에 다시 오면 처음부터 */
    });
  }

  function editing(){
    return !!(window.__DECK_EDIT_MODE || document.body.classList.contains('editing'));
  }

  /** 편집기가 붙는 순간 부른다 — 편집 중에 영상이 저 혼자 돌면 방해만 된다. */
  window.__peStopAll = function(){
    clearTimeout(cineTimer);
    document.querySelectorAll('.slide.pe-cine-wait').forEach(function(s){ s.classList.remove('pe-cine-wait'); });
    document.querySelectorAll('.pe-vslot video').forEach(function(v){ v.pause(); });
  };

  function enter(slide){
    slide.querySelectorAll('.pe-vslot').forEach(function(slot){
      setup(slot);
      var v = slot.querySelector('video');
      if (!v) return;
      v.muted = !(slot.dataset.sound === '1' && window.__DECK_SOUND);
      if (editing()) return;                  /* 편집 중엔 틀지 않는다 */
      if (slot.dataset.autoplay !== '0'){
        var p = v.play();
        if (p && p.catch) p.catch(function(){
          /* 브라우저가 막으면 음소거로 한 번 더 — 이건 언제나 통한다 */
          v.muted = true; v.play().catch(function(){});
        });
      }
    });

    /* 인트로: 영상만 먼저 보여주고 글을 늦춘다 */
    clearTimeout(cineTimer);
    var cine = slide.querySelector('.pe-imgzone[data-pos="cinema"] .pe-vslot');
    if (!cine) return;
    var delay = parseInt(cine.dataset.delay || '2500', 10);
    if (!(delay > 0) || editing()) return;
    if (window.matchMedia && window.matchMedia('print').matches) return;
    slide.classList.add('pe-cine-wait');
    cineTimer = setTimeout(function(){ slide.classList.remove('pe-cine-wait'); }, delay);
  }

  /** 기다리는 중에 넘기려 하면, 넘기지 말고 글부터 보여준다 */
  function revealNow(){
    var w = document.querySelector('.slide.pe-cine-wait');
    if (!w) return false;
    clearTimeout(cineTimer);
    w.classList.remove('pe-cine-wait');
    return true;
  }
  window.__peRevealIntro = revealNow;

  document.addEventListener('keydown', function(e){
    if (window.__DECK_EDIT_MODE || document.body.classList.contains('editing')) return;
    if (e.target && e.target.isContentEditable) return;
    if (['ArrowRight','ArrowDown',' ','PageDown','Enter'].indexOf(e.key) < 0) return;
    if (revealNow()){ e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);                                   /* 발표 장치보다 먼저 잡는다 */

  document.addEventListener('click', function(e){
    if (e.target.closest && e.target.closest('.pe-vbar,.pe-ui')) return;
    revealNow();
  });

  /* 발표 장치가 덱마다 다르다. class 변화를 지켜보는 쪽이 확실하다. */
  var seen = null;
  function sync(){
    var now = document.querySelector('.slide.active') || document.querySelector('.slide.visible');
    if (!now || now === seen) return;
    if (seen) leave(seen);
    seen = now;
    enter(now);
  }
  new MutationObserver(sync).observe(document.body, {
    subtree: true, attributes: true, attributeFilter: ['class']
  });

  function boot(){
    document.querySelectorAll('.pe-vslot,.pe-slot').forEach(function(s){
      if (s.querySelector('video')) setup(s);
    });
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 인쇄 직전엔 기다림을 풀어 둔다 — PDF 에 빈 장이 남지 않게 */
  window.addEventListener('beforeprint', function(){
    clearTimeout(cineTimer);
    document.querySelectorAll('.slide.pe-cine-wait').forEach(function(s){ s.classList.remove('pe-cine-wait'); });
  });
})();
`;

const BLOCK = `${OPEN}\n<script>${RUNTIME_JS}</script>\n${CLOSE}\n`;

/**
 * 덱 HTML 에 발표용 영상 장치를 꽂는다(있으면 최신본으로 갈아 끼운다).
 * 무대 바깥, </body> 바로 앞에 둔다.
 * @returns {{html:string, changed:boolean}}
 */
export function ensureVideoRuntime(html) {
  const stripped = html.replace(BLOCK_RE, "");
  const i = stripped.lastIndexOf("</body>");
  const next =
    i < 0 ? stripped + "\n" + BLOCK : stripped.slice(0, i) + BLOCK + stripped.slice(i);
  return { html: next, changed: next !== html };
}

/** 이미 꽂혀 있고 버전도 같은가 */
export function hasCurrentRuntime(html) {
  return html.includes(OPEN) && html.includes(CLOSE);
}

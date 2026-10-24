# -*- coding: utf-8 -*-
"""在线版构建：从单文件主版拆出 Three.js/OrbitControls，生成 repo/index.html（191KB 首屏）+ 独立库文件 + 多源加载器"""
import re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent
src = (ROOT / 'anhui-competitions-3d.html').read_text(encoding='utf-8')

# 1) 抽取内嵌库原文
m3 = re.search(r'<script type="text/plain" id="threeSrc">([\s\S]*?)</script>', src)
mo = re.search(r'<script type="text/plain" id="orbitSrc">([\s\S]*?)</script>', src)
assert m3 and mo, '未找到内嵌库块'
three_code = m3.group(1)
orbit_code = mo.group(1)
(ROOT / 'repo' / 'three.min.js').write_text(three_code, encoding='utf-8')
(ROOT / 'repo' / 'orbit.min.js').write_text(orbit_code, encoding='utf-8')

# 2) 删除内嵌库块
out = src.replace(m3.group(0), '<!-- three.min.js 已拆分为独立文件（在线加速） -->')
out = out.replace(mo.group(0), '<!-- orbit.min.js 已拆分为独立文件（在线加速） -->')

# 3) 替换 loadClassic 为多源加载器（CDN 优先 → Pages 本地回退）
old_loader_start = out.index('  /* 经典加载器：base64 → Blob URL → 顺序注入 script（THREE → OrbitControls → mainRun） */')
old_loader_end = out.index('})();', old_loader_start)
old_loader = out[old_loader_start:old_loader_end]

NEW_LOADER = r'''  /* 多源加载器（在线版）：CDN 优先 → Pages 本地回退；THREE → OrbitControls → mainRun */
  window.loadClassic = function(){
    var gl = false;
    try { var c = document.createElement('canvas'); gl = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch(e){}
    if (!gl) { window.__sceneFail(new Error('当前环境不支持 WebGL（3D 渲染不可用）')); return; }

    var THREE_SOURCES = [
      { url:'three.min.js', label:'站点本地' },
      { url:'https://registry.npmmirror.com/three/0.128.0/files/build/three.min.js', label:'CDN·npmmirror' },
      { url:'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js', label:'CDN·jsDelivr' },
    ];
    var ORBIT_SOURCES = [
      { url:'orbit.min.js', label:'站点本地' },
      { url:'https://registry.npmmirror.com/three/0.128.0/files/examples/js/controls/OrbitControls.js', label:'CDN·npmmirror' },
      { url:'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js', label:'CDN·jsDelivr' },
    ];

    function tryLoad(sources, i, check, ok, fail, label){
      if (i >= sources.length){ fail(); return; }
      var s = sources[i];
      window.__bootMsg && window.__bootMsg('正在加载 3D 引擎（' + (label||s.label) + '）…');
      var el = document.createElement('script');
      var done = false;
      var timer = setTimeout(function(){ if (!done){ done = true; el.remove(); tryLoad(sources, i+1, check, ok, fail, label); } }, 4000);
      el.onload = function(){
        if (done) return; done = true; clearTimeout(timer);
        if (check()) ok(); else tryLoad(sources, i+1, check, ok, fail, label);
      };
      el.onerror = function(){
        if (done) return; done = true; clearTimeout(timer);
        tryLoad(sources, i+1, check, ok, fail, label);
      };
      el.src = s.url;
      document.body.appendChild(el);
    }

    tryLoad(THREE_SOURCES, 0,
      function(){ return !!window.THREE; },
      function(){
        tryLoad(ORBIT_SOURCES, 0,
          function(){ return !!(window.THREE && window.THREE.OrbitControls); },
          function(){
            try { mainRun(); window.__sceneOK = true; window.__bootHide(); }
            catch(e){ window.__sceneFail(e); }
          },
          function(){ window.__sceneFail(new Error('OrbitControls 各源均加载失败（在线版需网络；离线请用完整单文件版）')); },
          '控制器');
      },
      function(){ window.__sceneFail(new Error('Three.js 各源均加载失败（在线版需网络；离线请用完整单文件版）')); });
  };
'''
out = out[:old_loader_start] + NEW_LOADER + out[old_loader_end:]

# 4) head 里加 preconnect + preload（提前握手、提前并行下载库文件）
out = out.replace('</head>',
  '<link rel="preconnect" href="https://registry.npmmirror.com" crossorigin>\n'
  '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>\n'
  '<link rel="preload" as="script" href="three.min.js">\n'
  '<link rel="preload" as="script" href="orbit.min.js">\n</head>', 1)

(ROOT / 'repo' / 'index.html').write_text(out, encoding='utf-8')
print('构建完成：')
print('  repo/index.html   ', len(out.encode("utf-8"))//1024, 'KB（在线版首屏）')
print('  repo/three.min.js ', len(three_code.encode("utf-8"))//1024, 'KB')
print('  repo/orbit.min.js ', len(orbit_code.encode("utf-8"))//1024, 'KB')

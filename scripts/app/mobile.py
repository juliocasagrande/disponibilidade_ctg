"""Empacotamento mobile (Capacitor Android/iOS) e recursos PWA do painel CTG Brasil."""
from io import BytesIO
import json
from pathlib import Path

from .caminhos import HTML_PAINEL, PASTA_PAINEL, RAIZ

COR_NAVY_HEX = '#051d33'
COR_NAVY_RGBA = (5, 29, 51, 255)

SERVICE_WORKER_JS = """const CACHE_NAME = 'ctg-disponibilidade-v1';
const ASSETS = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match('/')))
  );
});
"""

NATIVE_BRIDGE_JS = """(function () {
  'use strict';

  function initCapacitor() {
    var cap = window.Capacitor;
    if (!cap || !cap.Plugins) return;
    var plugins = cap.Plugins;

    if (plugins.StatusBar) {
      try {
        plugins.StatusBar.setStyle({ style: 'DARK' }).catch(function () {});
        plugins.StatusBar.setBackgroundColor({ color: '#051d33' }).catch(function () {});
        plugins.StatusBar.setOverlaysWebView({ overlay: false }).catch(function () {});
      } catch (_) {}
    }

    if (plugins.SplashScreen) {
      try {
        setTimeout(function () {
          plugins.SplashScreen.hide({ fadeOutDuration: 220 }).catch(function () {});
        }, 120);
      } catch (_) {}
    }

    if (plugins.App && typeof plugins.App.addListener === 'function') {
      try {
        plugins.App.addListener('backButton', function (ev) {
          if (typeof window.__ctgHandleBack === 'function' && window.__ctgHandleBack()) {
            return;
          }
          if (ev && ev.canGoBack) {
            window.history.back();
          } else if (typeof plugins.App.exitApp === 'function') {
            plugins.App.exitApp();
          }
        });
      } catch (_) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCapacitor);
  } else {
    initCapacitor();
  }
})();
"""


def _caminho_emblema():
    for nome in ('ctg_sphere.png', 'logo_ctg.png'):
        arq = PASTA_PAINEL / 'vendor' / nome
        if arq.is_file():
            return arq
    return None


def gerar_manifest_json(base_path='/'):
    prefixo = '' if base_path == './' else '/'
    return json.dumps(
        {
            'name': 'CTG Brasil | Disponibilidade e FID',
            'short_name': 'CTG FID',
            'description': 'Indicadores TEIFa, TEIP, ID, FID, Simulador 60 meses, Paradas Programadas e Projeção 2028 (SIN).',
            'start_url': './index.html' if base_path == './' else '/',
            'display': 'standalone',
            'orientation': 'portrait-primary',
            'background_color': COR_NAVY_HEX,
            'theme_color': COR_NAVY_HEX,
            'lang': 'pt-BR',
            'icons': [
                {'src': f'{prefixo}icons/icon-192.png', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any maskable'},
                {'src': f'{prefixo}icons/icon-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any maskable'},
            ],
        },
        ensure_ascii=False,
        indent=2,
    )


def gerar_icone_png_bytes(tamanho=512, escala_emblema=0.66):
    """Renderiza icone quadrado com fundo azul-marinho CTG e emblema centralizado (seguro para adaptive icons)."""
    emblema_path = _caminho_emblema()
    if not emblema_path:
        return b''
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return emblema_path.read_bytes()

    canvas = Image.new('RGBA', (tamanho, tamanho), COR_NAVY_RGBA)
    # Brilho radial sutil no centro para profundidade visual
    draw = ImageDraw.Draw(canvas, 'RGBA')
    cx = cy = tamanho // 2
    for i in range(6, 0, -1):
        r = int(tamanho * 0.48 * (i / 6))
        alpha = int(16 * (7 - i) / 6)
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(0, 122, 196, alpha))

    emblema = Image.open(emblema_path).convert('RGBA')
    alvo = max(16, int(tamanho * escala_emblema))
    emblema = emblema.resize((alvo, alvo), Image.Resampling.LANCZOS)
    pos = ((tamanho - alvo) // 2, (tamanho - alvo) // 2)
    canvas.alpha_composite(emblema, pos)

    buf = BytesIO()
    canvas.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def gerar_splash_png_bytes(tamanho=2732):
    """Renderiza splash screen de alta resolucao para Android/iOS."""
    return gerar_icone_png_bytes(tamanho=tamanho, escala_emblema=0.22)


def _atualizar_icones_nativos(pasta_mobile):
    """Aplica os icones CTG nos projetos nativos Android e iOS quando ja existirem."""
    android_res = pasta_mobile / 'android/app/src/main/res'
    if android_res.is_dir():
        densidades = {
            'mipmap-mdpi': 48,
            'mipmap-hdpi': 72,
            'mipmap-xhdpi': 96,
            'mipmap-xxhdpi': 144,
            'mipmap-xxxhdpi': 192,
        }
        for pasta, px in densidades.items():
            alvo_dir = android_res / pasta
            if alvo_dir.is_dir():
                icone = gerar_icone_png_bytes(px, escala_emblema=0.72)
                icone_fg = gerar_icone_png_bytes(max(108, px * 2), escala_emblema=0.52)
                (alvo_dir / 'ic_launcher.png').write_bytes(icone)
                (alvo_dir / 'ic_launcher_round.png').write_bytes(icone)
                (alvo_dir / 'ic_launcher_foreground.png').write_bytes(icone_fg)

        # Ajustar cor de fundo do icone adaptativo para azul-marinho CTG
        bg_xml = android_res / 'values/ic_launcher_background.xml'
        if bg_xml.is_file():
            bg_xml.write_text(
                '<?xml version="1.0" encoding="utf-8"?>\n'
                '<resources>\n'
                f'    <color name="ic_launcher_background">{COR_NAVY_HEX}</color>\n'
                '</resources>\n',
                encoding='utf-8',
            )

        # Atualizar splash screen do Android com o tema CTG Brasil
        splash_png = gerar_splash_png_bytes(1024)
        for sub in ('drawable', 'drawable-port-mdpi', 'drawable-port-hdpi', 'drawable-port-xhdpi',
                    'drawable-port-xxhdpi', 'drawable-port-xxxhdpi', 'drawable-land-mdpi',
                    'drawable-land-hdpi', 'drawable-land-xhdpi', 'drawable-land-xxhdpi', 'drawable-land-xxxhdpi'):
            alvo_splash = android_res / sub / 'splash.png'
            if alvo_splash.parent.is_dir():
                alvo_splash.write_bytes(splash_png)

    ios_icon = pasta_mobile / 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'
    if ios_icon.parent.is_dir():
        ios_icon.write_bytes(gerar_icone_png_bytes(1024, escala_emblema=0.72))


def exportar_bundle_mobile(raiz=RAIZ):
    """Gera mobile/www/ pronto para Capacitor (Android/iOS) a partir de resultados/painel/painel.html."""
    raiz = Path(raiz)
    origem_html = raiz / HTML_PAINEL
    if not origem_html.is_file():
        raise FileNotFoundError(f'Painel nao encontrado em {origem_html}. Execute python scripts/executar.py primeiro.')

    pasta_mobile = raiz / 'mobile'
    www = pasta_mobile / 'www'
    icons_dir = www / 'icons'
    res_dir = pasta_mobile / 'resources'
    icons_dir.mkdir(parents=True, exist_ok=True)
    res_dir.mkdir(parents=True, exist_ok=True)

    html = origem_html.read_text(encoding='utf-8')
    head_mobile = '<link rel="manifest" href="manifest.webmanifest">'
    bridge_tag = '<script src="native-bridge.js"></script>'
    if head_mobile not in html:
        html = html.replace('</head>', f'  {head_mobile}\n</head>', 1)
    if bridge_tag not in html:
        html = html.replace('</body>', f'{bridge_tag}\n</body>', 1)

    (www / 'index.html').write_text(html, encoding='utf-8')
    (www / 'manifest.webmanifest').write_text(gerar_manifest_json('./'), encoding='utf-8')
    (www / 'sw.js').write_text(SERVICE_WORKER_JS, encoding='utf-8')
    (www / 'native-bridge.js').write_text(NATIVE_BRIDGE_JS, encoding='utf-8')

    (icons_dir / 'icon-192.png').write_bytes(gerar_icone_png_bytes(192))
    (icons_dir / 'icon-512.png').write_bytes(gerar_icone_png_bytes(512))
    (res_dir / 'icon.png').write_bytes(gerar_icone_png_bytes(1024))
    (res_dir / 'splash.png').write_bytes(gerar_splash_png_bytes(1024))

    _atualizar_icones_nativos(pasta_mobile)
    return www / 'index.html'

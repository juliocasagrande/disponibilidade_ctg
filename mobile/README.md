# App Mobile Nativo — CTG Brasil (Disponibilidade e FID)

Projeto **Capacitor** para empacotar a aplicação como app nativo **Android** e **iOS** (com funcionamento **100% offline** para Visão Geral, Simulador FID, Paradas Programadas, Projeção 2028 e Metodologia & ONS), mantendo o layout desktop completamente inalterado.

## O que mudou na experiência Mobile (`<= 860px`)

- **Top App Bar nativa** em azul-marinho CTG com emblema, título/subtítulo contextual da tela, botão de **Filtros** com contador de filtros ativos e atalho discreto de **Administrador**.
- **Barra horizontal de chips de filtro** logo abaixo da navbar para visualizar de relance o Polo, Usina, Mês, Horizonte, Ano/Tipo ou fatores 2028 — toque em qualquer chip para editar diretamente.
- **Bottom Sheet nativo de filtros** (gaveta inferior deslizante com *swipe-down* para fechar, controles em tema claro otimizados para toque e botão **Aplicar e Ver Resultados**).
- **Bottom Tab Bar fixa** com 5 abas principais (`Geral`, `Simular`, `Paradas`, `Proj. 2028`, `ONS`) respeitando *safe-areas* (notch / barra de gestos) e com *haptic feedback* nativo.
- **Botão Voltar nativo do Android** integrado: fecha primeiro o Bottom Sheet de filtros, depois volta para Visão Geral antes de sair do app.

## Atualizar os dados do app após um novo cálculo

Sempre que recalcular ou baixar novos dados ONS/MME na raiz do projeto, o bundle `mobile/www/` é atualizado automaticamente:

```powershell
python scripts/executar.py --sync-mobile
cd mobile
npx cap sync
```

## Gerar APK Android

### Opção 1 — Localmente com Android Studio
1. Instale o [Android Studio](https://developer.android.com/studio) (com Android SDK).
2. Na pasta `mobile/`, abra o projeto nativo ou compile o APK:
   ```powershell
   npm run open:android
   # ou diretamente pela linha de comando:
   npm run build:apk
   ```
   O APK será gerado em `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

### Opção 2 — Build automático na nuvem (GitHub Actions)
O workflow `.github/workflows/build-android.yml` compila o APK automaticamente no GitHub Actions sem precisar instalar o Android Studio no Windows.

## Compilar iOS (iPhone / iPad)

Em um Mac com Xcode e CocoaPods instalados:

```bash
cd mobile
npm install
npx cap sync ios
npx cap open ios
```

## Testar no celular agora pela rede Wi-Fi (PWA instalável)

Você também pode abrir e instalar a versão mobile diretamente pelo navegador do celular (Chrome no Android / Safari no iOS → *"Adicionar à tela inicial"*):

```powershell
python scripts/executar.py --painel --host 0.0.0.0
```

Depois acesse `http://<IP-DO-SEU-PC>:8765` no celular conectado à mesma rede Wi-Fi.
No app nativo, você também pode conectar a esse servidor em **Admin → URL do Servidor CTG** para gravar cenários Parquet ou rodar consultas DuckDB remotamente.

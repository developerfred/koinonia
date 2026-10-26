<div align="center">

# Koinonia

**κοινωνία** — "compartilhar"

Estúdio de streaming no navegador e daemon em Zig para **Twitch** e **YouTube**.
Controlado por agentes via **WebMCP**. Sem OBS.

[Documentação](https://developerfred.github.io/koinonia/) · [Plano](PLANO.md) · [English](README.en.md) · [Contribuir](CONTRIBUTING.md)

![licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue)
![status](https://img.shields.io/badge/status-em%20constru%C3%A7%C3%A3o-orange)

</div>

> **Status honesto:** o projeto está em construção. Nenhuma transmissão real para
> Twitch ou YouTube foi testada ainda. A tabela [Status](#status) diz o que existe,
> o que foi verificado e o que falta.

## Por que existe

A maioria dos streamers pequenos não tem equipe: configura OBS, plugins e
serviços de clipe separados, e perde horas depois da live procurando
os melhores momentos. O Koinonia junta isso em um lugar:

- **Estúdio no navegador:** câmera, tela, cenas e codificação (WebCodecs) sem instalar OBS.
- **Daemon em Zig:** recebe o vídeo já codificado e envia por RTMP(S) para várias plataformas ao mesmo tempo, sem recodificar.
- **Agentes:** co-piloto, moderador, clipper, analista e economista de tokens operam a live pelas ferramentas WebMCP da própria página.
- **Clipes verticais e pós-live:** detecta momentos, reenquadra em 9:16, legenda e prepara o relatório da live.
- **Duas visualizações:** **Foco** (uma coisa por vez, calma) e **Painel** (tudo visível). Alternam a qualquer momento com `Alt+V`.

## Arquitetura

```
 Navegador (estúdio)                          Daemon Zig (koinonia-d)
┌──────────────────────────┐   WebSocket    ┌─────────────────────────────┐
│ câmera / tela / áudio    │  chunks H.264  │ framing → FLV → RTMP(S) ───►│ Twitch
│ cenas (OffscreenCanvas)  │ ─────────────► │              └────────────►│ YouTube
│ WebCodecs (H.264 / AAC)  │  127.0.0.1     │ buffer MPEG-TS (clipper)    │
│ ferramentas WebMCP       │                └─────────────────────────────┘
└────────────▲─────────────┘
             │ tools/list, tools/call
        Agentes (producer, moderator, clipper, analyst, economist)
             └── economia de tokens: compactação, roteamento, cache, orçamento
```

## Componentes

| Pasta | O que é |
|---|---|
| [`daemon/`](daemon) | `koinonia-d` em Zig: WebSocket local, FLV, RTMP(S) com fan-out, buffer de clipes |
| [`studio/`](studio) | Estúdio no navegador (TypeScript + Vite), ferramentas WebMCP, visualizações Foco e Painel |
| [`agents/`](agents) | Runtime multiagente com portão de aprovação humana e CLI `koinonia-agents` |
| [`tokens/`](tokens) | Biblioteca de economia de tokens (consumir e gastar) |
| [`connectors/`](connectors) | Chat unificado de Twitch e YouTube |
| [`clips/`](clips) | Detecção de momentos, reenquadramento 9:16, legendas, publicação e relatório pós-live |
| [`desktop/`](desktop) | App de desktop em Zig para Linux, Windows e macOS |
| [`site/`](site) | Documentação e landing page |
| [`qa/`](qa) | Testes de contrato, integração, e2e, fuzzing e segurança |

## Status

Legenda: **testado** = coberto por testes automáticos; **não verificado** = código existe, mas não foi exercitado contra o mundo real.

| Parte | Estado |
|---|---|
| Daemon: WebSocket, FLV, RTMP, fan-out, buffer TS | Testado com servidor RTMP falso. RTMPS contra Twitch/YouTube **não verificado** |
| Estúdio: ferramentas, chat, métricas, Foco/Painel | Testado em unidade e componente. Live real com câmera **não verificado** |
| Agentes e aprovação humana | Testado com provedor falso. API real da Anthropic **não verificada** |
| Economia de tokens | Testado. Preços do registro são **provisórios** |
| Chat unificado | Testado com transportes simulados. Contas reais **não verificado** |
| Clipes e pós-live | Lógica testada com dados sintéticos. Exportação e publicação são **interfaces** |
| App de desktop | Em desenvolvimento |

Ainda não existe: mixer de áudio com filtros, captura de janela por seletor, gravação local, alertas e overlays. O que falta, em ordem, está em [PLANO.md](PLANO.md).

## Segurança

- Chaves de stream e tokens nunca entram em log; aparecem como `****`.
- O daemon escuta só em `127.0.0.1`, confere `Origin` e aceita token opcional.
- Texto do chat é tratado como dado não confiável, nunca como instrução para agentes.
- Ações sensíveis (banir, apagar, encerrar a live, publicar clipe) exigem **aprovação humana**.

Para reportar uma vulnerabilidade, veja [SECURITY.md](SECURITY.md).

## Começando

Pré-requisitos: [Zig 0.17](https://ziglang.org/download/), Node.js 24+ e um navegador baseado em Chromium.

```bash
git clone https://github.com/developerfred/koinonia.git
cd koinonia
```

Daemon:

```bash
cd daemon && zig build test && zig build
```

Estúdio:

```bash
cd studio && npm install && npm run dev
```

Configure os destinos (chaves por variável de ambiente ou arquivo local, nunca no repositório) conforme [daemon/PROTOCOL.md](daemon/PROTOCOL.md) e a [documentação](https://developerfred.github.io/koinonia/).

## Contribuindo

Contribuições são bem-vindas. Leia [CONTRIBUTING.md](CONTRIBUTING.md) e o [Código de Conduta](CODE_OF_CONDUCT.md). Boas primeiras tarefas estão na seção "Para lançar" do [PLANO.md](PLANO.md).

## Licença

[MIT](LICENSE) © 2026 developerfred

# Koinonia (κοινωνία — "compartilhar")

Sistema open source para streamers (Twitch + YouTube) sem OBS. O navegador é o
estúdio; um daemon em Zig faz o encanamento. Agentes controlam tudo via WebMCP.

## Arquitetura
- **Navegador (estúdio)**: getUserMedia/getDisplayMedia, cenas num Worker com
  OffscreenCanvas, codificação H.264/AAC com WebCodecs (hardware quando houver).
- **Daemon Zig (`koinonia-d`)**: recebe chunks já codificados via WebSocket,
  empacota FLV -> RTMPS (Twitch e YouTube em paralelo) e MPEG-TS -> buffer do
  clipper. Sem reencode.
- **WebMCP**: a página registra ferramentas via `navigator.modelContext`.
  Execução devolve uma única Promise: streaming = cursor + estado vivo na página.

## Funcionalidades
1. **Co-piloto de produção**: get_chat(since_cursor), create_poll, pin_message,
   switch_scene, set_layer, set_audio, set_overlay_text, start_stream/stop_stream,
   capture_frame. Ações sensíveis (ban) exigem confirmação humana.
2. **Clipper**: buffer circular de N minutos; mark_highlight(), export_clip(seconds_back, title).
3. **Painel de dados**: SSE/WebSocket, query_window(last), set_alert(threshold),
   saúde da live (kbps, frames descartados).
4. **Agente de economia de tokens** (novo, ver abaixo).

## Agente de economia de tokens (gastar e consumir)
Objetivo: reduzir custo de tokens tanto no que o sistema **gasta** (chamadas ao
LLM) quanto no que o agente **consome** (saída das ferramentas).

Consumir (o que entra no contexto do agente):
- Respostas de ferramentas compactas: delta por cursor, nunca estado completo.
- Chat resumido: dedupe de mensagens repetidas, agrupamento por tema, limite de itens.
- Campos opcionais por `fields`/`verbosity`; esquemas enxutos.
- Ferramentas registradas só quando relevantes (toolchange).

Gastar (o que sai para o LLM):
- Roteamento de modelo: tarefa simples -> modelo pequeno; complexa -> grande.
- Prompt caching de prefixos estáveis (sistema, ferramentas, regras da live).
- Orçamento por sessão/hora com limites, alertas e degradação graciosa.
- Cache semântico de respostas repetidas; batching de eventos em janelas.
- Resumo rolante da conversa em vez de histórico bruto.
- Métricas: tokens por ferramenta/tarefa, economia estimada, painel no Koinonia.

## Fases
0. Spikes de risco: aba em segundo plano (fps) e AAC no WebCodecs.
1. Spike ponta a ponta: câmera -> WebCodecs -> Zig -> Twitch.
2. YouTube em paralelo (RTMPS), chat de ambas as plataformas.
3. Ferramentas WebMCP do co-piloto.
4. Clipper com buffer circular.
5. Painel de dados.
6. Agente de economia de tokens.
7. Docs, CI, release open source.

# Spec — Rodada 1: fundação, comandos e skill roteadora

Fork: `madebysandro/grok-plugin-cc` · branch `feat/melhorias-media` · base `arielaizn/grok-plugin-cc@4e45064` (v1.0.0)
Data: 2026-09-24 · Grok CLI de referência: **1.0.41** (código aberto: https://github.com/xai-org/grok-build)
Decisões: sessão de grilling de 2026-09-24 (resumo em §2). Esta spec cobre **só a Rodada 1**; as receitas ficam para a Rodada 2 (§9).

## 1. Objetivo

Aproximar o plugin da experiência das skills `higgsfield-*`, usando **só a assinatura do Grok (SuperGrok Plus) pelo Grok CLI**: sem `XAI_API_KEY`, sem custo por uso. O modelo é o do Higgsfield: poucos comandos de geração, utilitários locais determinísticos e uma skill roteadora que o Claude segue. O usuário só usa o Grok quando pede explicitamente.

## 2. Decisões (fechadas)

| # | Decisão |
|---|---|
| Uso | Vídeo curto/anúncios, personagem/mascote consistente, produto/marketplace, peças com texto exato, apresentador falando. **Fora por ora:** assets de jogo e 3D. |
| Superfície | Poucos comandos de geração + utilitários locais + **receitas como skills** (não como comandos). |
| Projeto | Fork pessoal. Código, README e mensagens do plugin **em inglês**; esta spec em português. |
| API paga | **Fora.** Nada de `XAI_API_KEY`, nada de chamar `api.x.ai` diretamente. |
| Qualidade × cota | Vídeo padrão **720p**. `--draft` = 480p/6 s. Trabalhos com vários clipes: o Claude propõe rascunho 480p antes (regra da skill roteadora). |
| Modelo de imagem | **`grok-imagine-image-2.0` é o padrão** (testado: acerta texto em PT-BR, 1280×720, ~35 s). `--image-model` permite voltar. |
| Execução | **Primeiro plano** por padrão (imagem ~20–35 s, vídeo ~30–40 s). Segundo plano só para lotes ou quando pedido. |
| Biblioteca | **Por projeto**: `grok-media/library/<nome>/` (imagem canônica, turnaround, `traits.md`, `brand.json` quando for marca). Sem biblioteca global. |
| Acionamento | Skill roteadora `grok-generate` chama o companion via Bash; dispara **só** quando o usuário cita o Grok. Slash commands continuam para uso manual. |
| Git | Aviso **uma vez** se `grok-media/` estiver num repositório git sem regra de ignore; nunca editar `.gitignore`. |
| Testes ao vivo | Até **12 gerações**, sempre na menor configuração (480p, duração mínima). Passou disso, perguntar ao usuário. |
| Entrega | Commits na branch `feat/melhorias-media`. **Sem merge na `main` e sem trocar o plugin instalado** — o usuário decide depois da revisão. |

## 3. Fatos que a implementação deve respeitar

Fontes: código do Grok CLI 1.0.41 (`crates/codegen/xai-grok-tools/src/implementations/grok_build/{image_gen,image_edit,video_gen}/mod.rs`), `~/.grok/docs/user-guide/` (`05-configuration.md`, `08-skills.md`, `14-headless-mode.md`, `26-config-reference.md`), schemas reais em `~/.grok/sessions/*/*/tool_definitions.json`, docs.x.ai, testes ao vivo de 2026-09-24.

### 3.1 Ferramentas

| Ferramenta | Parâmetros e limites |
|---|---|
| `image_gen` | `prompt`, `aspect_ratio` (doc: 1:1, 16:9, 9:16, 3:2, 2:3, auto). CLI fixa `n=1` e `resolution="1k"`. O CLI não valida o aspect. |
| `image_edit` | `prompt`, `image[]` (caminho absoluto, data URL ou token `[Image #N]`), `aspect_ratio` só em multi-imagem: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9, 9:19.5, 20:9, 9:20, auto. **Reduz referências a ≤768 px / ~400 KB.** |
| `image_to_video` | `image` (obrig.), `prompt`, `duration` **6 ou 10**, `resolution_name` **480p ou 720p** (padrão do tool: 480p). Sem aspect (segue a imagem). Áudio sempre ligado. |
| `reference_to_video` | `prompt` e `aspect_ratio` obrig. (1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3); `images` ≤14 (tags `<IMAGE_i>`); `voices` ≤3 (tags `<AUDIO_i>`); `keyframes` ≤4 `{image, timestamp_s}` estritamente dentro do clipe, grade de 1/3 s; `first_frame`/`last_frame`; `duration` 1–15 (padrão 6); `resolution_name` 480p/720p. Ordem das tags: `first_frame`, `images`, `keyframes`, `last_frame`. first = last → loop. Existe um **schema antigo** (≤7 imagens, sem frames/keyframes). O post oficial fala em "até 7 referências" — validar >7 ao vivo. |

- 1080p é recusado **pelo próprio CLI** ("`resolution_name` must be one of: 480p, 720p").
- Todo vídeo sai com trilha AAC real (H.264, 24 fps).
- Override do modelo de imagem: `GROK_IMAGE_GEN_MODEL_OVERRIDE` / `GROK_IMAGE_EDIT_MODEL_OVERRIDE`. Controle testado: modelo inexistente → HTTP 404 citando o nome (a variável é respeitada). IDs: `grok-imagine-image-2.0`, `grok-imagine-image-quality` (padrão atual do servidor, **aposentado em 2026-11-02**), `grok-imagine-image`.

### 3.2 Isolamento do headless

Hoje cada chamada carrega 14 plugins do Claude, 216 skills, MCPs e hooks do usuário, **inclusive este plugin** (risco de recursão Grok → plugin → Grok). Controles documentados em `26-config-reference.md` §compat:
`GROK_CLAUDE_{SKILLS,AGENTS,HOOKS,MCPS,RULES}_ENABLED=false`, `GROK_CURSOR_{SKILLS,AGENTS,HOOKS,MCPS,RULES}_ENABLED=false`. Flags: `--tools <allowlist>`, `--no-subagents`, `--disable-web-search`, `--no-auto-update`, `-s/--session-id <uuid novo>` (cria sessão; erro se existir).
Não há variável documentada para parar de carregar **plugins** do Claude — verificar com `grok inspect --json` (ver T3).

### 3.3 Ambiente local confirmado

ffmpeg/ffprobe (`/opt/homebrew/bin`), ImageMagick (`magick`), Python com Pillow, numpy, scipy, Google Chrome (`/Applications/Google Chrome.app`). **Ausentes:** OpenCV, rembg, Real-ESRGAN — não instalar nada.

## 4. Arquitetura e seams para TDD

Companion (`plugins/grok/scripts/grok-companion.mjs`) fino; lógica testável em `scripts/lib/` e `scripts/*.py`.

| Módulo | Responsabilidade | Testes |
|---|---|---|
| `lib/media-spec.mjs` *(escrito, sem testes/ligação)* | Validar aspect/duração/resolução por comando, `--draft`, entradas do ref-video, keyframes, limite de referências conforme schema | unitários puros |
| `lib/prompts.mjs` *(parcialmente alterado)* | Templates enviados ao Grok (verbatim, sem cópia/shell) | unitários puros |
| `lib/invocation.mjs` *(novo; extrair de `grok.mjs`)* | `buildGrokInvocation(command, opts)` → `{ args, env }`: allowlist, isolamento, session-id, override de modelo, guarda de recursão | unitários puros |
| `lib/compat.mjs` *(escrito, sem testes/ligação)* | Schema das ferramentas e auto-teste de colheita a partir das sessões em disco | fixtures em diretório temporário |
| `lib/refs.mjs` *(novo)* | Resolver entradas: caminho, `@last`, `job:<id>`, `job:<id>#N` | unitários com state fake |
| `lib/ffmpeg.mjs` *(novo)* | `probe`, `lastFrame`, `concat`, `mute`, `reframe` | integração com clipes de `ffmpeg -f lavfi testsrc`/`sine` (pular se ffmpeg ausente) |
| `lib/overlay.mjs` *(novo)* | Montar o HTML do texto sobre a imagem a partir de opções + `brand.json` | unitários puros (HTML gerado) |
| `lib/html-render.mjs` *(novo)* | Renderizar HTML → PNG no tamanho nativo com Chrome headless | integração (pular se Chrome ausente) |
| `lib/git-notice.mjs` *(novo)* | Detectar `grok-media/` em repo git sem ignore; lembrar que já avisou | integração com repo git temporário |
| `scripts/cutout.py` *(novo)* | Chroma key → PNG RGBA com despill | teste com imagem sintética |
| `scripts/sheet.py` *(novo)* | Recorte de folhas em itens (receita `~/.grok/bundled/skills/game-assets/assets.md`) | teste com imagem sintética |

Regras gerais: validar **antes** de chamar o Grok (erro → exit 1, sem criar job); nunca ler de `~/.grok/auth.json` além dos campos que o plugin já usa (e-mail, ZDR); nunca chamar `api.x.ai` diretamente; mensagens do plugin em inglês.

## 5. Tickets

Cada ticket: testes no mesmo commit; `npm test` verde; critérios de aceite verificáveis.

### Fundação

**T1 — Validação de opções ligada aos comandos**
- `resolveMediaSpec` roda em `runMediaCommand` antes de qualquer chamada ao Grok.
- `image`: aspect ∈ lista do `image_gen`. `edit`: lista do `image_edit`. `animate`: rejeita `--aspect`; duração 6|10 (padrão 6); resolução 480p|720p (**padrão 720p**). `video`: idem + aspect do `image_gen`. `ref-video`: aspect (padrão 16:9), duração 1–15, resolução.
- `--draft` em `animate`/`video`/`ref-video` = 480p e duração mínima permitida (6 para os dois primeiros; 6 no ref-video salvo `--duration` explícito). `--draft` + `--resolution` explícita → erro claro.
- `--resolution 1080p` → mensagem: o CLI só aceita até 720p; o 1080p do plano vale no app.
- Manifesto grava `duration`, `resolution`, `draft`.
- Aceite: testes para cada regra, incluindo os casos reais (3 s recusado, 1080p recusado); `animate` sem flags pede 720p.

**T2 — Prompts**
- `buildAnimatePrompt` sem aspect e com `resolution_name`; `buildVideoPrompt` com resolução no passo `image_to_video`; `buildReferenceVideoPrompt` (argumentos em JSON + prompt verbatim). Já iniciado em `prompts.mjs`.
- Companion para de passar aspect ao animate.
- Aceite: testes atualizados/novos em `tests/prompts.test.mjs`.

**T3 — Isolamento e velocidade do headless**
- `buildGrokInvocation` monta, para mídia: `--tools` com allowlist por comando (image: `image_gen`; edit: `image_edit`; animate: `image_to_video`; video: `image_gen,image_to_video`; ref-video: `reference_to_video`), `--no-subagents`, `--disable-web-search`, `--no-auto-update`, `--session-id <uuid gerado>`; env com as dez variáveis `GROK_{CLAUDE,CURSOR}_*_ENABLED=false`.
- Guarda de recursão: filho recebe `GROK_PLUGIN_CC_WORKER=1`; o companion recusa comandos de mídia se essa variável já estiver no ambiente.
- `ask` não muda (mantém toolset completo).
- Verificar com `grok inspect --json` (sob o mesmo env) se plugins do Claude ainda carregam; registrar o resultado em `docs/live-tests.md` e, se carregarem, documentar no `grok-cli-runtime` (a guarda de recursão cobre o risco).
- Aceite: unitários de `buildGrokInvocation`; medição ao vivo **antes/depois** (tempo e `usage.input_tokens` de uma imagem) registrada no CHANGELOG.

**T4 — Image 2.0 como padrão e `--image-model`**
- `image` e `edit` definem `GROK_IMAGE_GEN_MODEL_OVERRIDE`/`GROK_IMAGE_EDIT_MODEL_OVERRIDE` = `grok-imagine-image-2.0` por padrão.
- `--image-model 2.0|quality|standard|server` (`server` = não definir, usa o do servidor).
- Manifesto grava o modelo pedido.
- Aceite: unitários do env; 1 teste ao vivo de `edit` com 2.0 (o de `image` já foi feito).

**T5 — `/grok:setup` com teste de fumaça sem custo**
- Ligar `lib/compat.mjs`: (a) ferramentas de mídia no `tool_definitions.json` mais recente com toolset completo — faltando alguma → FAIL; (b) auto-teste de colheita na sessão mais recente com mídia em disco — mídia que o parser não acha → FAIL "session log format changed"; (c) avisos se as descrições passarem a citar resoluções/durações novas.
- Detectar schema do `reference_to_video` (antigo: ≤7 imagens, sem frames; novo: ≤14) e usar esse limite no T6; expor em `setup --json`.
- Mostrar plano e flags não sensíveis de `~/.grok/settings_cache.json` (`subscription_tier_display`, `image_gen_enabled`, `video_gen_enabled`, `imagine_tools_disabled`).
- Estados ok / FAIL / not verified (sem sessões) — "not verified" não bloqueia.
- Aceite: testes com fixtures (mídia + log bom → ok; mídia sem log reconhecível → FAIL; descrição com "1080p" → aviso; schema antigo → limite 7).

### Comandos

**T6 — `/grok:ref-video`**
- Flags: `--image` (repetível), `--first-frame`, `--last-frame`, `--keyframe PATH@SEG` (repetível), `--voice` (repetível), `--aspect`, `--duration`, `--resolution`, `--draft`, `--loop` (first = last = `--image` único; prompt ganha "locked camera, seamless loop").
- Pelo menos uma entrada; limites do schema detectado (T5).
- Vozes: lista estática com os IDs oficiais (buscar em https://docs.x.ai/developers/model-capabilities/audio/voice.md e text-to-speech.md na implementação); ID desconhecido → erro local com a lista. Se a lista não puder ser obtida, aceitar qualquer ID minúsculo e repassar o erro da ferramenta.
- `commands/ref-video.md` explica as tags e a ordem de indexação.
- Aceite: unitários (prompt JSON exato, limites, keyframes, loop); testes ao vivo do §6.

**T7 — Referências a resultados anteriores**
- Toda flag de imagem/vídeo de entrada aceita `@last` (último arquivo gerado no workspace, pelo manifesto/state) e `job:<id>` / `job:<id>#N`.
- Aceite: unitários de `lib/refs.mjs`; `/grok:animate "…" --image @last` resolve o arquivo certo.

**T8 — Utilitários de vídeo locais** (`lib/ffmpeg.mjs`, sem Grok, sem cota)
- `last-frame <video> [--out]` → PNG do último quadro real (`-sseof -0.05`).
- `concat <a> <b> … [--out] [--reencode]` → stream copy; se resolução/fps/codec diferirem, erro sugerindo `--reencode`.
- `mute <video> [--out]` → remove áudio sem reencodar vídeo.
- `reframe <imagem|vídeo> --aspect 9:16 [--mode crop|pad] [--anchor center|top|bottom]` → crop centralizado ou pad (fundo desfocado da própria mídia); sem IA.
- Aceite: integração com clipes sintéticos (duração, dimensões, presença/ausência de áudio conferidas com ffprobe).

**T9 — `overlay` (texto exato sobre imagem)**
- `overlay --image <base> --text "…" [--sub "…"] [--brand <brand.json>] [--position top|center|bottom] [--style clean|bold|glass] [--out]`.
- `lib/overlay.mjs` gera HTML no tamanho nativo da imagem; `lib/html-render.mjs` renderiza com Chrome headless (`CHROME_PATH` ou caminho padrão do macOS), esperando as fontes carregarem.
- `brand.json` (convenção, documentada na skill): `{ "name", "colors": { "primary", "secondary", "accent", "text", "background" }, "fonts": { "heading", "body" } (nomes Google Fonts), "logo": "<caminho relativo>" }`.
- Aceite: unitários do HTML (texto escapado, cores/fontes do brand, posição); integração do render (dimensão de saída = dimensão da base).

**T10 — `cutout` e `split`** (Python local)
- `cutout <imagem> [--key #00FF00] [--tolerance N] [--out]` → PNG RGBA com despill (`scripts/cutout.py`, numpy/Pillow).
- `split <folha> [--expect N] [--bg auto|#hex] [--out]` → um PNG RGBA por item (`scripts/sheet.py`, receita `assets.md`: chroma por distância, componentes conectados scipy, merge <3 % da largura, descarta <0,05 % da área, padding ~6 %, mesmo canvas); falha se contagem ≠ `--expect` ou item tocando a borda.
- Aceite: testes com imagens sintéticas (3 formas → 3 PNGs; fundo verde → alfa 0 no fundo).

**T11 — Primeiro plano por padrão e aviso de git**
- Atualizar `commands/*.md`: executar em primeiro plano; `--background` só quando o usuário pedir ou em lotes.
- `lib/git-notice.mjs`: se o diretório de saída estiver num repo git e não for ignorado (`git check-ignore`), anexar uma nota à saída **uma vez por workspace** (lembrar no state do plugin). Nunca editar `.gitignore`.
- Aceite: integração com repo git temporário (avisa uma vez; não avisa se ignorado).

### Skills, docs e distribuição

**T12 — Skill roteadora `grok-generate` e skills existentes**
- Nova `skills/grok-generate/SKILL.md`, espelho do `higgsfield-generate`:
  - descrição que dispara **só** quando o usuário pede Grok explicitamente;
  - tabela intenção → comando/flags;
  - regras de UX: responder no idioma do usuário; uma pergunta por vez; não reescrever o prompt; primeiro plano; vários clipes → propor rascunho `--draft` antes; sem retry automático; entregar caminho + resumo de uma linha; ler e mostrar imagens geradas;
  - limites reais (§3) e o que **não** existe (1080p, 2k, edição/extensão nativa de vídeo, TTS/música, 3D);
  - convenção da biblioteca `grok-media/library/<nome>/` (canônica, turnaround, `traits.md`, `brand.json`) — as receitas que a usam ficam para a Rodada 2.
- Atualizar `grok-cli-runtime` (fatos do §3, isolamento, schemas antigo/novo), `grok-imagine-prompting` (tags e ordem, staging, texto curto direto no 2.0, texto longo via `overlay`), `grok-media-results` (verificar vídeo com ffprobe e quadros extraídos).
- Atualizar o subagente `grok-media` para os comandos novos.

**T13 — README, CHANGELOG, versão, registro de testes**
- README em inglês: seção "Fork notes", tabela de comandos, limites reais, comparação resumida com Higgsfield.
- Versão `2.0.0` em `plugin.json`, `marketplace.json`, `package.json`; `homepage`/`repository` → fork; manter crédito ao autor original.
- `docs/live-tests.md`: cada geração ao vivo com data, comando, resultado, dimensões/duração (ffprobe), id da sessão — sem segredos.
- Não mexer na instalação do plugin do usuário nem na `main`.

## 6. Testes ao vivo (máx. 12 gerações; menor configuração)

Já validado antes desta spec (não conta): `image_gen` 1:1 e 16:9; `image_to_video` 480p 6 s; 3 s recusado; 1080p recusado; colheita no 1.0.41; override de modelo (controle 404 + Image 2.0 com texto PT-BR correto).

| # | Ticket | Teste |
|---|---|---|
| 1–2 | T3 | Uma imagem antes e uma depois do isolamento (tempo, `input_tokens`) |
| 3 | T4 | `edit` com Image 2.0 |
| 4 | T1 | `animate` 720p 6 s (conferir dimensões reais no ffprobe) |
| 5 | T1 | `video --draft` (texto → vídeo em 480p) |
| 6 | T6 | `ref-video` com 2 referências, 480p, 4 s |
| 7 | T6 | `ref-video --loop` (1º e último quadro quase iguais) |
| 8 | T6 | `ref-video --voice` com fala em **português** (fala audível e inteligível; se ruim, documentar a limitação) |
| 9 | T6 | `ref-video` com 8 referências (limite real acima de 7?) |
| 10–12 | — | Reserva para refazer algo que falhar. Passou de 12: perguntar ao usuário |

## 7. Fora de escopo (definitivo)

1080p/4K, imagens 2k, `n>1`, edição/extensão nativa de vídeo, música/SFX/TTS avulsos, voz clonada, Soul ID treinado, vetor nativo, upscale por IA, Virality Predictor, URLs hospedadas, import de produto/marca por URL, API paga, 3D, assets de jogo.

## 8. Riscos

- Auto-update do Grok CLI muda schemas/log → T5 avisa no `setup`; testes com fixtures.
- Pool semanal único (Chat, Imagine, Voice, Build) → `--draft` e teto de 12 gerações.
- Aposentadoria do `grok-imagine-image-quality` em 2026-11-02 → já coberto pelo T4.
- Plugins do Claude possivelmente ainda carregados no headless → guarda de recursão (T3).

## 9. Rodada 2 (não implementar agora)

Receitas em skills, escritas depois de o usuário usar a Rodada 1: vídeo com vários planos (`shots.json` mantido pelo Claude, continuidade pelo último quadro, montagem com `concat`), extensão de vídeo, apresentador falando, personagem/mascote (biblioteca por projeto; copiar o Sabichão do projeto `sabichao` no primeiro uso), produto/marketplace, miniatura/peça com texto (gerar `brand.json` da Punto a partir da skill `punto-brand`).

## 10. Estado atual da branch

- `lib/media-spec.mjs` e `lib/compat.mjs` escritos, sem testes nem ligação ao companion (`media-spec` ainda não tem `--draft` nem limite de referências por schema).
- `lib/prompts.mjs` alterado (resolução, animate sem aspect, `buildReferenceVideoPrompt`); 55/55 testes originais passando.
- Nada commitado.

# Plugin Grok para o Claude Code

<img src="docs/hero.jpg" alt="Fotografias impressas espalhadas sobre a mesa de um desenvolvedor, diante de um monitor aceso" width="100%">

<sub>Todas as imagens deste README foram feitas com o plugin: geradas pelo Grok ou finalizadas por uma das ferramentas locais dele. Esta: `/grok:image A developer's desk at night lit only by the glow of a monitor… --aspect 16:9`</sub>

Gere, edite e anime imagens e vídeos com o [Grok CLI](https://x.ai/build) sem sair do Claude Code, e finalize tudo na sua própria máquina: último quadro, junção, remoção de áudio, reenquadramento, texto exato e recortes. Funciona só com a assinatura do Grok, sem chave de API, e também pode ser instalado no Codex.

**[Read in English](README.md)** · [Changelog](plugins/grok/CHANGELOG.md) · [Registro dos testes ao vivo](docs/live-tests.md)

- **Gere e edite** imagens com o Image 2.0, que acerta textos curtos e acentos.
- **Anime** uma imagem, ou crie um clipe a partir de uma descrição, em 720p (ou num rascunho barato em 480p).
- **Dirija um vídeo a partir de referências**: pessoas e produtos consistentes, primeiro e último quadros exatos, quadros-chave, vozes prontas e loops perfeitos.
- **Finalize localmente, sem gastar cota**: último quadro, junção de clipes, remoção de áudio, reenquadramento, texto exato sobre a imagem, recorte de fundo verde e divisão de uma folha em itens.
- **Ou só peça ao Claude** para "usar o Grok para…": uma skill roteadora escolhe o comando e as opções, e só age quando você cita o Grok.

## Começo rápido

Você precisa do **Grok CLI** com login feito (instale em [x.ai/build](https://x.ai/build) e rode `grok login`) e do **Node.js 18.18+**. As ferramentas locais precisam de alguns programas opcionais, listados em [Requisitos](#requisitos).

No Claude Code:

```
/plugin marketplace add madebysandro/grok-plugin-cc
/plugin install grok@madebysandro-grok
/reload-plugins
/grok:setup
```

No Codex:

```bash
codex plugin marketplace add https://github.com/madebysandro/grok-plugin-cc
codex plugin add grok@madebysandro-grok
```

O `/grok:setup` confere, sem custo, se o CLI está instalado e com login, se as ferramentas de mídia continuam do jeito que o plugin espera, o que o seu plano consegue gerar e se a xAI lista modelos do Imagine mais novos que os do plugin. Depois:

```bash
/grok:image a vintage brass telescope on a wooden desk beside an open star chart, warm lamplight --aspect 16:9 --name telescope
/grok:edit change the lamp glass to deep blue and cool the scene to moonlight --image @last
/grok:animate slow push-in, dust drifting through the light --image @last --draft
```

Os arquivos vão para `grok-media/` no seu workspace.

## Comandos

| Comando | O que faz | Onde roda |
| --- | --- | --- |
| `/grok:image` | Gera imagens (Image 2.0 por padrão) | Grok |
| `/grok:edit` | Edita uma imagem, ou combina várias | Grok |
| `/grok:video` | Um clipe a partir de uma descrição: uma imagem e depois a animação dela | Grok |
| `/grok:animate` | Anima uma imagem que você já tem | Grok |
| `/grok:ref-video` | Um clipe a partir de imagens de referência, primeiro e último quadros fixos, quadros-chave e vozes prontas | Grok |
| `/grok:ask` | Passa uma tarefa geral ao Grok (só leitura, a menos que use `--write`) | Grok |
| `/grok:last-frame` | Salva o último quadro de um clipe como PNG, para começar o próximo clipe por ele | ffmpeg |
| `/grok:concat` | Junta clipes em sequência | ffmpeg |
| `/grok:mute` | Tira o áudio de um clipe | ffmpeg |
| `/grok:reframe` | Muda a proporção de uma imagem ou de um clipe, cortando ou completando com uma cópia desfocada | ffmpeg |
| `/grok:overlay` | Texto exato sobre uma imagem, montado em HTML no tamanho dela, opcionalmente a partir de um `brand.json` | Chrome |
| `/grok:cutout` | Transforma um fundo verde em transparência | Python |
| `/grok:split` | Divide uma folha (vistas de um personagem, grade de produtos, conjunto de ícones) em um PNG transparente por item | Python |
| `/grok:setup` | Confere CLI, login, plano, compatibilidade e os modelos atuais da xAI, sem custo | local |
| `/grok:status` | Lista os jobs recentes deste workspace, de qualquer tipo | local |
| `/grok:result` | Mostra os arquivos e as notas de um job | local |
| `/grok:cancel` | Cancela um job em andamento | local |

Os comandos do Grok consomem a cota semanal do seu plano. Os outros rodam nesta máquina e não custam nada.

O plugin também traz o subagente `grok-media`, para trabalhos com várias peças, e quatro skills: `grok-generate` (a roteadora: qual comando, quais opções, os limites reais), `grok-imagine-prompting` (como escrever prompts, tags do `ref-video`, preparo para recortes), `grok-media-results` (como conferir um resultado antes de entregá-lo) e `grok-cli-runtime` (como o plugin conduz o CLI).

## Como fica

### Gerar e depois editar

O `image_edit` muda só o que você pede e deixa o resto do quadro como está. Por isso, iterar é editar, e não gerar de novo. Aqui a edição mudou a luminária e a cor da cena; o telescópio, os mapas e as peças de latão continuaram no mesmo lugar.

<table>
<tr>
<td width="50%"><img src="docs/edit-before.jpg" alt="Um telescópio de latão sobre uma mesa de madeira ao lado de mapas estelares, com luz quente de uma luminária verde"></td>
<td width="50%"><img src="docs/edit-after.jpg" alt="A mesma mesa e o mesmo telescópio, agora com uma luminária azul-escura e luz fria de luar"></td>
</tr>
<tr>
<td><sub><code>/grok:image a vintage brass telescope on a wooden desk beside an open star chart, warm lamplight, shallow depth of field --aspect 16:9</code></sub></td>
<td><sub><code>/grok:edit change the lamp glass to deep blue and cool the whole scene to moonlight, keep everything else identical --image @last</code></sub></td>
</tr>
</table>

### Texto nas imagens

O Image 2.0, modelo padrão, escreve bem textos curtos, inclusive com acentos. Para um texto que precisa sair exato, o `/grok:overlay` monta o texto em HTML sobre a imagem e renderiza com o Chrome, nas fontes e cores de um `brand.json`.

<table>
<tr>
<td width="50%"><img src="docs/variations-1.jpg" alt="Um logo de grão de café em traço fino acima da palavra ROASTERY"></td>
<td width="50%"><img src="docs/gallery/edit-text-pt.jpg" alt="O mesmo logo, agora com TORREFAÇÃO e CAFÉ no lugar de ROASTERY e COFFEE"></td>
</tr>
<tr>
<td colspan="2"><sub><code>/grok:edit Replace the word ROASTERY with TORREFAÇÃO and the small word COFFEE with CAFÉ. Keep everything else exactly the same. --image logo.jpg</code></sub></td>
</tr>
<tr>
<td colspan="2"><img src="docs/gallery/overlay.jpg" alt="A foto do telescópio em luz azul com um painel escuro translúcido escrito Star Party, Friday, 9 pm, on the rooftop"></td>
</tr>
<tr>
<td colspan="2"><sub><code>/grok:overlay --image edit-after.jpg --text 'Star Party' --sub 'Friday, 9 pm · on the rooftop' --brand brand.json --style glass</code> · o arquivo da marca é o <a href="docs/gallery/brand-example.json"><code>docs/gallery/brand-example.json</code></a></sub></td>
</tr>
</table>

### Animar uma imagem, ou começar por palavras

O `/grok:animate` pede 720p, e o resultado saiu com 1280×720 de verdade. O `/grok:video` gera a imagem primeiro e depois a anima; o `--draft` pede o nível 480p do Grok, um jeito barato de testar uma ideia.

<table>
<tr>
<td width="55%"><img src="docs/gallery/animate-hero.gif" alt="A foto da mesa ganhando movimento: a câmera se aproxima e o brilho do monitor pisca"></td>
<td width="45%"><img src="docs/gallery/video-draft-frame.jpg" alt="Uma pipa vermelha de papel com fitas sobre uma praia tranquila ao entardecer"></td>
</tr>
<tr>
<td><sub><code>/grok:animate slow camera push-in across the desk; steam rises from the mug and the monitor glow flickers softly --image hero.jpg</code> · 1280×720, 6 s</sub></td>
<td><sub><code>/grok:video a red paper kite drifting over a quiet beach at dusk --aspect 16:9 --draft</code> · um quadro do rascunho em 736×400</sub></td>
</tr>
</table>

### Dirigir um vídeo a partir de referências

O `/grok:ref-video` usa a ferramenta `reference_to_video`. As imagens de referência entram no prompt como `<IMAGE_0>`, `<IMAGE_1>`… e as vozes prontas como `<AUDIO_0>`…; `--first-frame` e `--last-frame` fixam as pontas, `--keyframe CAMINHO@SEGUNDOS` fixa o meio, e `--loop` usa a mesma imagem como primeiro e último quadro.

<table>
<tr>
<td width="25%"><img src="docs/gallery/ref-apple-1.jpg" alt="Referência: uma maçã vermelha"></td>
<td width="25%"><img src="docs/gallery/ref-apple-2.jpg" alt="Referência: outra maçã vermelha"></td>
<td width="50%"><img src="docs/gallery/ref-two-frame.jpg" alt="As duas maçãs lado a lado sobre uma mesa branca"></td>
</tr>
<tr>
<td colspan="3"><sub><code>/grok:ref-video '&lt;IMAGE_0&gt; and &lt;IMAGE_1&gt; side by side on a white table, slow camera push-in' --image apple-1.jpg --image apple-2.jpg --duration 4 --draft</code></sub></td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="docs/gallery/ref-loop.gif" alt="Uma maçã vermelha girando devagar sobre uma mesa branca, em loop perfeito"></td>
<td width="50%"><img src="docs/gallery/ref-voice-frame.jpg" alt="Uma jovem na mesa da foto de abertura, virando-se para a câmera para falar"></td>
</tr>
<tr>
<td><sub><code>/grok:ref-video 'a red apple slowly turning on a white table' --image apple-1.jpg --loop --duration 4 --draft</code> · o primeiro e o último quadro coincidem (SSIM 0,96)</sub></td>
<td><sub><code>/grok:ref-video '&lt;IMAGE_0&gt; sets the scene: a young woman sits at this desk, turns to the camera and says in Brazilian Portuguese, in the voice &lt;AUDIO_0&gt;: …' --image hero.jpg --voice eve --duration 6 --draft</code> · a fala em português saiu inteligível</sub></td>
</tr>
<tr>
<td colspan="2"><img src="docs/gallery/ref-eight-frame.jpg" alt="Uma parede de galeria com quadros feitos a partir de oito imagens de referência"></td>
</tr>
<tr>
<td colspan="2"><sub><code>/grok:ref-video 'a slow pan along a gallery wall showing &lt;IMAGE_0&gt;, … and &lt;IMAGE_7&gt; as framed prints' --image … (8 imagens) --duration 4 --draft</code> · as oito referências foram aceitas</sub></td>
</tr>
</table>

### Reenquadrar para outra tela

O `/grok:reframe` transforma uma peça 16:9 em 9:16 (ou em qualquer `L:A`) sem IA: cortando em volta de uma âncora, ou completando com uma cópia desfocada da própria imagem. Funciona com imagens e com clipes.

<table>
<tr>
<td width="50%"><img src="docs/gallery/reframe-pad.jpg" alt="A foto da mesa num quadro 9:16, completada em cima e embaixo por uma cópia desfocada dela mesma"></td>
<td width="50%"><img src="docs/gallery/reframe-crop.jpg" alt="A foto da mesa cortada em 9:16 em volta do centro"></td>
</tr>
<tr>
<td><sub><code>/grok:reframe hero.jpg --aspect 9:16 --mode pad</code></sub></td>
<td><sub><code>/grok:reframe hero.jpg --aspect 9:16 --mode crop</code></sub></td>
</tr>
</table>

### Recortes e folhas

Gere um produto ou um personagem sobre fundo verde liso e desmonte localmente. O `/grok:cutout` transforma o fundo em transparência sem deixar borda verde; o `/grok:split` salva um PNG transparente por item, todos na mesma tela, e o `--expect` confere a quantidade.

<table>
<tr>
<td colspan="2"><img src="docs/gallery/mug-sheet.jpg" alt="Três vistas de uma caneca de terracota sobre fundo verde liso"></td>
</tr>
<tr>
<td colspan="2"><sub><code>/grok:image Product turnaround sheet of one matte terracotta ceramic coffee mug, shown three times in a single row… on a flat solid pure green #00FF00 background with even studio lighting. --aspect 16:9</code></sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/gallery/mug-sheet-cutout.jpg" alt="A mesma folha com o verde transformado em transparência, mostrada sobre um xadrez"></td>
<td width="50%"><img src="docs/gallery/mug-sheet-split.jpg" alt="As três canecas como imagens transparentes separadas, mostradas sobre um xadrez"></td>
</tr>
<tr>
<td><sub><code>/grok:cutout @last</code> · mostrado sobre um xadrez</sub></td>
<td><sub><code>/grok:split @last --expect 3</code> · três PNGs, mostrados lado a lado</sub></td>
</tr>
</table>

### Variações

O `--count` roda o `image_gen` várias vezes sobre o mesmo assunto. Não existe seed, então o resultado são versões realmente diferentes, e não pequenas variações da mesma imagem. Isso ajuda na fase de conceito, e é por isso que um assunto *recorrente* precisa vir da edição de uma imagem base, ou do `/grok:ref-video` com essa imagem como referência.

<table>
<tr>
<td width="50%"><img src="docs/variations-1.jpg" alt="Um logo de grão de café em traço fino com um torrador dentro, acima da palavra ROASTERY"></td>
<td width="50%"><img src="docs/variations-2.jpg" alt="Um logo de grão de café em traço fino montado em volta da letra R, com vapor subindo, acima da palavra ROASTERY"></td>
</tr>
<tr>
<td colspan="2"><sub><code>/grok:image a minimalist flat-vector logo mark for a coffee roastery, single warm-brown color on cream --count 2 --aspect 1:1</code></sub></td>
</tr>
</table>

## Trabalhando com os resultados

### Encadeando com `@last` e `job:<id>`

Toda geração e toda ferramenta local informa o id do job na saída (`jobId` com `--json`). Qualquer entrada de arquivo aceita então `@last` (o último arquivo que o plugin salvou neste workspace, por uma geração ou por uma ferramenta local), `job:<id>` (o primeiro arquivo daquele job) ou `job:<id>#N` (o N-ésimo arquivo). Um job de `video` guarda a imagem e o clipe, então `job:<id>#1` é a imagem. As entradas de imagem de `edit`, `animate` e `ref-video` também aceitam uma URL `data:`.

Uma peça mais longa, do começo ao fim, em que só as etapas do Grok gastam cota:

```bash
/grok:image a lighthouse on a rocky point at dusk, waves breaking --aspect 16:9 --name lighthouse
/grok:animate the beam sweeps across the sky, waves roll in --image @last --draft   # testa a ideia em 480p
/grok:animate the beam sweeps across the sky, waves roll in --image job:<job da imagem>  # a versão final, em 720p
/grok:last-frame @last                                                              # o último quadro dela…
/grok:ref-video 'night falls over <IMAGE_0>, the camera pulls back' --first-frame @last --duration 6
/grok:concat job:<primeiro clipe> @last                                             # …junta os dois clipes
/grok:reframe @last --aspect 9:16 --mode pad                                         # uma versão vertical
/grok:mute @last                                                                    # e uma sem áudio
```

### Onde ficam os arquivos

Por padrão, os arquivos vão para `grok-media/` (`--out PASTA` muda isso). O nome vem do prompt, do arquivo de entrada ou do `--name`, com numeração, e nada é sobrescrito. O `grok-manifest.json` registra, para cada arquivo, o prompt que foi de fato enviado, a ferramenta que o gerou e a proporção, a duração, a resolução, se foi rascunho, o modelo de imagem e o custo que o Grok informou para a execução.

Na primeira vez que uma execução salva numa pasta de repositório git que o git não ignora, a saída avisa, uma vez por pasta. O plugin nunca altera o `.gitignore`.

### A biblioteca do projeto

Para personagens, mascotes, produtos e marcas que precisam se manter iguais entre as peças, guarde uma pasta para cada um em `grok-media/library/<nome>/`:

- `canonical.jpg` (ou `.png`): a imagem de referência, usada como `--image` no `edit` e no `ref-video`.
- `turnaround.jpg`: vistas de frente, de lado e de costas sobre fundo verde, e as vistas separadas que o `/grok:split` tira dela.
- `traits.md`: o que não pode mudar (rosto, proporções, roupa, cores, posição do logo).
- `brand.json`: cores, fontes e logo de uma marca, para o `/grok:overlay --brand`.

```json
{
  "name": "Café Aurora",
  "colors": { "primary": "#C0392B", "secondary": "#F5E6CC", "accent": "#F1C40F", "text": "#FFFFFF", "background": "rgba(20, 10, 5, 0.6)" },
  "fonts": { "heading": "Playfair Display", "body": "Inter" },
  "logo": "logo.png"
}
```

`text` colore o título e `accent` o subtítulo; `primary` preenche a faixa do estilo `bold`; `background` e `secondary` formam o painel do estilo `glass` e a borda dele. Uma fonte pode ser uma família do Google Fonts (baixada pela rede na hora de renderizar) ou o caminho de um arquivo `.ttf`, `.otf`, `.woff` ou `.woff2`, embutido para não depender de rede. O caminho do logo é relativo ao `brand.json`.

### Pedindo ao Claude

Com o plugin instalado, você pode pedir com suas palavras, como em "usa o Grok para fazer um clipe 9:16 de…". A skill `grok-generate` escolhe o comando e as opções, propõe um `--draft` antes quando a peça precisa de vários clipes, roda em primeiro plano e entrega o arquivo com um resumo de uma linha. Ela só age quando você cita o Grok, então um "faz um vídeo" genérico fica com a ferramenta que você escolher.

## Opções

| Opção | Significado |
| --- | --- |
| `--out PASTA` | Pasta de saída (padrão `grok-media/`) |
| `--name NOME` | Nome base do arquivo |
| `--aspect PROPORÇÃO` | `image`/`video`, e `edit` com 2 ou mais imagens: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, `21:9`, `5:2`, `auto` (`21:9` e `5:2` só no Image 2.0). `ref-video`: `1:1`, `16:9` (padrão), `9:16`, `4:3`, `3:4`, `3:2`, `2:3`. O `animate` mantém o formato da imagem. O `reframe` aceita qualquer `L:A` |
| `--count N` | `image`/`edit`: quantidade de resultados, de 1 a 8, feitos em paralelo |
| `--image CAMINHO` | Imagem de entrada do `edit` (repetível, até 5), do `animate`, do `ref-video` (repetível: as referências) e do `overlay`. Aceita um caminho, `@last` ou `job:<id>[#N]` |
| `--image-model M` | `image`/`edit`/`video`: `2.0` (padrão, `grok-imagine-image-2.0`, o modelo de imagem atual da xAI), `standard` (1.0, que expande o prompt), `server` para o padrão da xAI, ou o id de um modelo mais novo |
| `--duration SEG` | `video`: `6` (padrão) ou `10`. `animate` e `ref-video`: de 1 a 15 (padrão 6) |
| `--resolution R` | `animate`/`video`/`ref-video`: `720p` (padrão) ou `480p` |
| `--draft` | `animate`/`video`/`ref-video`: o nível 480p do Grok, com 6 s, a menos que `--duration` diga outra coisa |
| `--background` | Num comando de barra, faz o Claude rodar a geração como job em segundo plano (veja `/grok:status`), em vez de esperar |
| `--model` · `--effort` | Modelo do Grok e esforço de raciocínio |
| `--timeout SEG` | Tempo limite: de 30 a 3600 nas execuções do Grok (o `ask` ajusta um valor fora da faixa, os outros recusam); o `overlay` aceita de 1 a 600 (padrão 60) |
| `--json` | Saída legível por máquina |
| `--verbatim=false` | Deixa o Grok reescrever o seu prompt, em vez de repassá-lo como está |

O `ref-video` tem entradas próprias (`--first-frame`, `--last-frame`, `--keyframe CAMINHO@SEGUNDOS`, `--voice ID`, `--loop`), e cada ferramenta local tem algumas opções suas (`--mode` e `--anchor` no `reframe`, `--reencode` no `concat`, `--key` e `--tolerance` no `cutout`, `--expect` e `--bg` no `split`, `--text`, `--sub`, `--brand`, `--position` e `--style` no `overlay`). A dica de argumentos de cada comando lista todas, assim como `node plugins/grok/scripts/grok-companion.mjs help`.

As opções são conferidas antes de qualquer execução. Um valor que a ferramenta recusaria (3 s, 1080p), ou uma opção do plugin que o comando não usa, é recusado na hora, sem criar job e sem gastar cota, e a mensagem diz como corrigir. O `ask` aceita as opções que sempre aceitou e recusa as outras. Uma flag que o plugin não conhece (`--seed 5`) não é opção para ele: um comando do Grok manda essa flag ao Grok como parte do prompt, e uma ferramenta local a trata como uma das entradas e para.

## Limites reais

Medidos no Grok CLI 1.0.41, nas execuções ao vivo de [`docs/live-tests.md`](docs/live-tests.md) e nas checagens feitas logo antes delas (§6 da spec), e aplicados antes de o Grok rodar sempre que o plugin consegue.

| | |
| --- | --- |
| **Imagens** | Cerca de 1K: 1024×1024 no quadrado, 1280×720 no formato largo, 1568×672 em 21:9. Uma imagem por chamada de ferramenta; o `--count` faz várias chamadas, em paralelo. O CLI não escolhe qualidade, então o Image 2.0 serve a geração no nível baixo e a edição no médio. |
| **Referências do edit** | Até 5 por edição no Image 2.0. O CLI envia um JPEG ou PNG de até 400 KB do jeito que está e reduz qualquer coisa maior para 768 px; o plugin envia essa foto como uma cópia de 1536 px no lugar (Python com Pillow). Um texto pequeno ou um logo detalhado na referência ainda podem ser redesenhados: acrescente o texto exato depois com o `/grok:overlay`. |
| **Resolução do vídeo** | 720p ou o nível 480p, nada acima disso. O 720p saiu com 1280×720 de verdade a partir de uma imagem 16:9. "480p" é um nível, não 480 linhas: o `animate` deu 736×400 a partir de uma imagem 1280×720, e o `reference_to_video` com imagens de referência deu 848×480 em 16:9. O próprio CLI recusa 1080p (`resolution_name must be one of: 480p, 720p`); o 1080p do plano vale no app do Grok. |
| **Duração do vídeo** | `video`: 6 ou 10 s. `animate` e `ref-video`: de 1 a 15 s (o `animate` faz as durações diferentes de 6 e 10 s pelo `reference_to_video`, com a imagem fixada como primeiro quadro). |
| **Som** | Todo clipe sai em H.264 a 24 fps com trilha AAC, sempre, mais uma imagem de capa MJPEG como segundo stream de vídeo. O `/grok:mute` gera uma cópia sem som. |
| **Entradas do `ref-video`** | O schema aceita até 14 imagens de referência (7 nos CLIs antigos, o que o `/grok:setup` detecta); 8 foram aceitas ao vivo. Até 3 vozes prontas e 4 quadros-chave. |
| **Tempo** | Uma imagem leva de 15 a 35 s, e um clipe de 45 a 65 s. |
| **Não existe** | Vídeo em 1080p ou 4K, imagens 2k, escolha da qualidade da imagem, edição ou extensão nativa de vídeo, fala ou música avulsas, vozes clonadas, 3D, seed, prompt negativo. |

## Vale saber

**O seu prompt é repassado como está.** A skill `imagine` que vem com o Grok reescreveria os prompts, e isso descarta em silêncio a direção de arte que você deixou explícita. Use `--verbatim=false` quando *quiser* que ele elabore.

**Não existe prompt negativo**, e pedir a ausência de algo costuma trazer justamente esse algo. A primeira tentativa da imagem de abertura terminava com `no visible text or logos` e voltou com seis QR codes espalhados pelas fotografias; dizer o que as fotos *deviam* mostrar resolveu na primeira tentativa. Descreva o que você quer presente, não o que quer fora.

**Não existe seed.** O mesmo prompt dá uma imagem diferente a cada vez. Para um personagem ou produto consistente, gere uma imagem base e derive as outras com o `/grok:edit`, ou passe-a ao `/grok:ref-video` como referência, e guarde-a na biblioteca do projeto.

**Não existe ferramenta de texto para vídeo.** O Grok CLI 1.0 oferece `image_gen`, `image_edit`, `image_to_video` e `reference_to_video`. Por isso o `/grok:video` faz duas etapas, gera o quadro de abertura e depois o anima, e guarda os dois arquivos.

**As execuções de mídia são isoladas.** Cada comando de mídia oferece ao Grok só a ferramenta de que precisa e desliga, naquela execução, as suas skills, hooks, servidores MCP e regras do Claude e do Cursor. Isso mantém o agente focado, e uma imagem caiu de 23,8 s para 14,7 s e de 58,6 mil para 26,1 mil tokens. Os plugins do Claude continuam carregando, porque o Grok não tem como desligá-los; por isso todo processo do Grok aberto pelo plugin recebe uma marca, e o plugin se recusa a abrir o Grok de novo de dentro dele.

**As gerações rodam em primeiro plano.** Uma imagem leva de 15 a 35 s e um clipe cerca de um minuto, então os comandos esperam e mostram o resultado. Só vão para segundo plano quando você passa `--background` ou pede, ou num lote. Nada é repetido automaticamente.

**Cota.** Numa assinatura do Grok, cada execução consome o pool semanal do plano, que é compartilhado entre Chat, Imagine, Voice e Build, inclusive o `ask`. O Grok ainda informa quanto cada turno do agente teria custado (de US$ 0,012 a 0,027 por execução nos testes ao vivo, principalmente tokens do agente, não a mídia), e o manifesto guarda esse valor.

**Os arquivos são recolhidos do log de sessão do Grok,** e não copiados pelo agente. O Grok grava a mídia em `~/.grok/sessions/<cwd-codificado>/<id-da-sessão>/`; o plugin lê o `updates.jsonl` para achar os caminhos e copia os arquivos ele mesmo, o que não gasta turno extra e não tem como ser parafraseado.

**Vídeo falha em contas com Zero Data Retention.** Se a sua conta xAI tem `coding_data_retention_opt_out: true`, toda chamada de vídeo retorna:

```
HTTP 400: Zero Data Retention teams must provide output.upload_url for video generation.
```

A xAI exige que quem usa ZDR informe um destino de upload, e o CLI não oferece esse parâmetro, então a configuração da conta precisa mudar. Imagens e edição não são afetadas, e o `/grok:setup` avisa isso logo de início.

### Limitações conhecidas

- `--draft false` e `--duration 10 s` são lidos como texto do prompt, e `--draft=0` ou `--draft=no` contam como `--draft`.
- O `/grok:setup` lê o plano de um cache de configurações cujo formato nunca foi confirmado, então o plano pode aparecer como `unknown`. Isso não bloqueia nada.
- A proteção contra recursão só reconhece execuções do Grok abertas por este plugin, e não uma sessão do Grok que você abre por conta própria com o plugin carregado.
- O `ask` mantém as opções da 1.0.0 e recusa as que chegaram na 2.0.0.

## Plugin Grok × Higgsfield

Uma comparação resumida com as skills do Higgsfield para o Claude Code, conforme elas se descrevem em setembro de 2026. Este plugin troca variedade e teto de qualidade pela vantagem de rodar numa assinatura que você talvez já tenha.

| | Este plugin (Grok CLI) | Skills do Higgsfield |
| --- | --- | --- |
| **O que cada execução consome** | O pool semanal da assinatura do Grok, compartilhado com Chat, Imagine, Voice e Build. Sem chave de API. | Créditos do Higgsfield, por geração |
| **Modelos** | Só o Grok Imagine: Image 2.0 para imagens, as ferramentas de vídeo do Grok | Muitos: GPT Image 2.5, Nano Banana, Soul, Seedance, Kling, Veo e outros |
| **Teto do vídeo** | 720p; de 1 a 15 s a partir de uma imagem ou de referências | Seedance 2.5 até 1080p e de 4 a 30 s; 4K com o Seedance 2.0 |
| **Consistência** | Imagens de referência, primeiro e último quadros fixos e quadros-chave no `ref-video`; edições a partir de uma imagem base | Soul ID (uma identidade treinada), modelos guiados por referência |
| **Áudio** | Todo clipe vem com som gerado; vozes prontas só no `ref-video`. Nada de áudio avulso | Áudio avulso: voz, áudio musical e efeitos sonoros |
| **Edição de vídeo** | Nada nativo. Último quadro → novo clipe → `concat`, e `reframe`, rodando localmente | Fluxos de edição, extensão e reenquadramento |
| **Texto exato** | Image 2.0 para textos curtos, `/grok:overlay` para o que precisa sair exato | GPT Image 2.5 para texto na imagem |
| **Além disso** | `cutout` e `split` localmente | 3D, estúdios de anúncio e de foto de produto, cards de marketplace, miniaturas, Virality Predictor |
| **Onde ficam os resultados** | Arquivos no seu workspace, com um manifesto | URLs hospedadas |

## Requisitos

- **Grok CLI** com login feito: instale em [x.ai/build](https://x.ai/build) e rode `grok login`. As execuções contam na sua conta xAI; numa assinatura do Grok, consomem o pool semanal do plano.
- **Node.js 18.18+**
- Opcionais, para as ferramentas locais. O plugin não instala nada, e avisa qual falta quando uma ferramenta precisar dele:
  - **ffmpeg** (com ffprobe) para `last-frame`, `concat`, `mute` e `reframe`.
  - **Python 3 com Pillow, numpy e scipy** para `cutout` e `split`. `GROK_PLUGIN_PYTHON` escolhe outro interpretador em vez do `python3` do PATH.
  - **Google Chrome ou Chromium** para o `overlay`. O plugin procura o app do macOS e depois `google-chrome` ou `chromium` no PATH; `CHROME_PATH` aponta um executável específico. Ele sempre roda sem janela, com um perfil descartável, e nunca mexe no seu perfil do Chrome nem no seu keychain.

### Trocando do plugin original

O marketplace do fork se chama `madebysandro-grok`, e não `grok-plugin-cc` como o original, então os dois marketplaces podem ficar lado a lado. Os dois oferecem um plugin chamado `grok` com os mesmos comandos `/grok:*`, porém, então mantenha só um instalado: para trocar a partir do original, desinstale-o antes (`/plugin uninstall grok@grok-plugin-cc` no Claude Code, `codex plugin remove grok@grok-plugin-cc` no Codex).

## Desenvolvimento

```bash
npm test        # sem rede e sem Grok CLI; os testes que precisam de ffmpeg, Python ou Chrome são pulados se eles faltarem
```

O companion também é um CLI comum:

```bash
node plugins/grok/scripts/grok-companion.mjs help
node plugins/grok/scripts/grok-companion.mjs setup
node plugins/grok/scripts/grok-companion.mjs image "a red apple" --out ./shots --json
```

A estrutura do código está descrita na seção "Development" do [README em inglês](README.md#development). As notas de projeto desta versão estão em [`docs/spec-paridade-higgsfield.md`](docs/spec-paridade-higgsfield.md).

## Notas do fork e licença

Este é o [`madebysandro/grok-plugin-cc`](https://github.com/madebysandro/grok-plugin-cc), um fork do [`arielaizn/grok-plugin-cc`](https://github.com/arielaizn/grok-plugin-cc) de **Ariel Aizenshtat**, que escreveu o plugin original (1.0.0), por sua vez construído no formato do [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc). A versão 2.0.0 é a primeira do fork: ela busca a experiência das skills do Higgsfield (poucos comandos de geração, ferramentas locais que não precisam de IA e uma skill roteadora que o Claude segue) usando só a assinatura do Grok. Todas as mudanças estão no [CHANGELOG](plugins/grok/CHANGELOG.md), em inglês.

MIT; veja a [LICENSE](LICENSE), que mantém o aviso de copyright original.

Sem vínculo com a xAI, a OpenAI ou a Higgsfield. "Grok" é marca registrada da xAI.

# SurrealEd — RiotTools

Ferramentas para os arquivos do **Riot Engine** usados em *The Suffering* (2004) e *The Suffering: Ties That Bind* (2005).
Tools for the **Riot Engine** files used by *The Suffering* (2004) and *The Suffering: Ties That Bind* (2005).

---

## Português

### Instalação
1. Instale o **Python 3.8 ou mais novo** (python.org; marque "Add Python to PATH"). Nenhuma outra biblioteca é necessária.
2. Copie a pasta **RiotTools** inteira para dentro da pasta do jogo, ao lado do `Suffering.exe` ou do `SufferingTTB.exe`.
3. Dê dois cliques em **`RiotTools\SurrealEd.bat`**. O editor abre no navegador (Chrome, Edge ou Firefox atual).
   Feche a janela preta para encerrar.

Se a pasta RiotTools estiver em outro lugar: `python RiotEditor.py --game "E:\Jogos\The Suffering"`.

### O que funciona nesta versão (0.1)
- **Aba Fase:** abre qualquer `.lvl` direto dos arquivos do jogo — terreno, objetos, texturas, luz pré-calculada (`.ldu`),
  Point Lights, filtro por classe, seleção de objetos, salas/células/portais/PVS, modos com/sem textura e wireframe,
  e normais desenhadas como linhas (azul = normal do vértice, do arquivo; ciano = normal da face) no objeto selecionado
  ou, sem seleção, nos objetos perto do centro da câmera.
- **Painel de propriedades** do objeto selecionado: transformação, flags (visível, projeta sombra dinâmica…) e todas as
  propriedades da classe, com os valores do template e os que a instância muda. Somente leitura por enquanto.
- **Gizmos de mover, girar e escalar** (como no Unreal: `Q` selecionar, `W` mover, `E` girar, `R` escalar, espaço alterna,
  `` ` `` local/mundo), com encaixe em grade, desfazer/refazer (`Ctrl+Z` / `Ctrl+Y`) e "reverter". As mudanças são gravadas
  no .lvl com **File → Save level** (`Ctrl+S`). A rotação encaixa em graus inteiros, porque é assim que o jogo guarda.
- **Sombras dinâmicas** (World Settings → Iluminação), como no jogo: projeta quem tem a flag efetiva (0x1000 → 0x400;
  sem ela, o bit 0 das flags do template), silhueta 256×256 vista da Point Light mais forte, elevação até 45°, fade
  entre Level Properties p14 e p15. No painel Details dá para ligar/desligar a sombra de um objeto (prévia, não grava).
- **Propriedades e luzes editáveis:** no painel Details, números, cores (roda estilo UMG), mensagens e referências de
  cada objeto viram campos; o que dá para ver muda na hora (cor, intensidade e liga/desliga de Point Lights reacendem
  o visor) e tudo vai para o .lvl como override da instância. Listas ainda são só leitura.
- **Neblina do jogo** (Viewport rendering → Neblina do jogo): linear na profundidade, fim = Sky Properties p2, início =
  p3 × p2, cor p4. Em World Settings os três campos são editáveis com prévia ao vivo e "Gravar no template" grava no
  .odu do céu — isso muda **todas** as fases que usam o mesmo céu.
- **Materiais animados** (Viewport rendering → Animar materiais): Animating Material troca de quadro no fps dele;
  Advanced Material aplica escala/deslocamento de UV e a curva de rolagem do `.wdu` (água, fumaça, lodo).
- **Copiar, colar e apagar objetos** (Edit, ou Ctrl+C / Ctrl+V / Ctrl+D / Del, com Ctrl+Z): a cópia nasce 1 m ao lado
  (ou um passo da grade) e é gravada com id novo, folha na árvore de células (no nó cuja caixa contém a posição) e
  linha no histórico do editor. Apagar só grava se nenhum link, propriedade de objeto, portal ou trilha de STOMP
  apontar para o objeto. A cópia usa a luz pré-calculada do original.
- **STOMP na fase:** na aba STOMP, "Tocar na fase (3D)" abre a fase e toca a sequência no visor: objetos andam e giram
  pelas chaves, a trilha Camera assume a câmera (com FOV e escala de tempo), visibilidade, sons e legendas na hora, e
  um registro das outras chaves. "Câmera da cena" desmarcado deixa olhar de fora. A cena mostra os objetos das trilhas mesmo
  quando estão escondidos no início, espera os personagens carregarem antes de tocar e, sem trilha de câmera, enquadra
  onde a ação acontece. Personagens e objetos com esqueleto
  tocam as animações das chaves (canal 0, com mistura e movimento da raiz travado/livre); canais parciais ainda não.
- **Luzes e objetos escondidos:** cada Point Light tem um ícone clicável (até 25 m da câmera); objetos com a flag 0x8
  (o jogo não cria no início) ficam escondidos por padrão; passes "tingidos" de material ficam sem luz e com a cor da
  tinta, como no jogo; objetos sem luz pré-calculada recebem Ambient Light + Directional Light da fase.
- **Lógica da fase:** no painel Details, as propriedades de mensagem aparecem marcadas como entrada/saída, os valores
  de mensagem têm nome (1 On, 6 Triggered…) e a seção "Links" mostra o que o objeto manda, para quem, e quais
  mensagens cada alvo realmente ouve (linhas âmbar/azuis no visor; clique para ir até o objeto). Os mapas de mensagem
  dos dois jogos foram extraídos dos .rfl (`Ghidra/Atlas/RiotMessageMaps.py`, `Tools/RiotMessageNames.py`).
- **Abas de recursos:** Texturas, Modelos, Animação, **Áudio** (forma de onda, curva da boca, legenda, distâncias, salvar
  WAV), **STOMP** (sequências: trilhas por objeto da fase, eventos por tipo, vista de cima, reprodução com os sons, abrir a
  fase no objeto) e **Vídeo** (salvar .wmv; pré-visualização em MP4 se o `ffmpeg` estiver no PATH).
- **Céu (skybox)** (Viewport rendering → Céu): as camadas Sky / Sun são desenhadas em volta da câmera, antes da fase;
  a cúpula (p6 = 1) usa o degradê da Sky Properties (p4 horizonte, p5 céu, p6 faixa, p7 degradê); nuvens rolam.
- **Desempenho** (Viewport rendering → Desempenho): mostra a GPU que o navegador usa (avisa se for renderização por
  software: SwiftShader, llvmpipe, Microsoft Basic Render/WARP), FPS, tempo de lógica e de desenho e as chamadas de
  desenho; resolução interna 100/75/50%. Malhas fora da tela não são desenhadas. Tamanho dos ícones ajustável.
- **Visor da fase**: barra no topo com as ferramentas (selecionar/mover/girar/escalar, local/mundo, encaixes) e os
  menus **Transform** e **View** (estilo Blender): vistas de eixo no teclado numérico (7/1/3, Alt inverte, 5 alterna
  perspectiva/ortográfica), ortográfica automática, travar rotação, exibição Normal/Arame/Overdraw/Luz/Sem
  sombreamento, exibição avançada (as opções antigas), ambiente, ícones, gizmo, grade, informações, tempo de quadro,
  meia resolução, prévia cinematográfica, focar a origem (O), alinhar objeto à vista (Ctrl+Alt+Kp 0 / Ctrl+Alt+F).
- **Aba STOMP**: escolhe-se a fase (cenário); a lista mostra as sequências dos .qdu da pasta dela que usam objetos
  dela; a cena toca no próprio visor 3D (com personagens), trilhas e chaves embaixo. **Editável:** arrastar chaves
  muda o tempo, clique duplo cria chave, o painel edita os valores de cada tipo, <kbd>K</kbd> grava a pose (câmera do
  visor ou objeto), Desfazer/Refazer, Salvar troca só aquela sequência no .qdu, "Voltar ao original"; Exportar/Importar
  JSON editável.
- **Aba Material**: materiais de um pacote como nós (texturas/quadros/camadas/curva .wdu → material → saída) com prévia
  ao vivo; parâmetros editáveis; Salvar troca só os slots mudados no .odu; Exportar/Importar JSON.
- **Aba Scripting**: a lógica da fase como nós (objetos, mensagens de saída/entrada, ligações); pontos de entrada à
  direita; ligar/desligar arrastando fios; editar mensagens; grava no .lvl.
- **Aba Textos (Strings)**: textos dos .xdu, edição no lugar, Exportar/Importar TSV, grava só o que mudou.
- **Gravação a partir do original**: desfazer todas as mudanças devolve o arquivo idêntico byte a byte ao original.
- **Aba Texturas**: W/S (ou ↑/↓) anda uma linha da grade, A/D (ou ←/→) um quadro.
- **Efeitos de partículas** (Viewport rendering → Efeitos de partículas; `Editor/RiotParticles.js`, `Riot/RiotEffects.py`):
  TS1 Particle Fountain, Object Generator (os que soltam fountains) e Billboard; TTB Particle System - Simple
  (significados **deduzidos** do .rfl da TTB), Billboard Light Cone (lido do código do SufferingTTB.exe) e Billboard.
  Efeitos sem modelo ganham um ícone de estrela laranja clicável.
  Os que o jogo só liga por mensagem tocam quando selecionados ou com "Prévia dos efeitos ligados por mensagem".
- **Atalhos das abas de recursos** (Modelos, Animação, Áudio, STOMP, Vídeo): <kbd>W</kbd>/<kbd>S</kbd> (ou setas) mudam o item
  da lista, <kbd>Espaço</kbd> toca/para. Durante uma cena STOMP, marcadores do editor e colisão invisível somem da frente.
- A interface abre em inglês; para português use **View → Português** (a escolha fica salva no navegador).
- **Gravação** (sempre com backup): na primeira vez que um arquivo é alterado, o original vai para
  `SurrealEd Backup/` dentro da pasta do jogo (nunca é sobrescrito). O contêiner é regravado mantendo o layout original;
  sem mudanças, sai idêntico byte a byte (`python Tools/RiotRoundTrip.py "<pasta do jogo>"` confere os 405 arquivos).
  - **Fase:** flags (exceto 0x10, 0x100 e 0x8000, que mudam o tamanho do registro) e transformação → **Arquivo → Salvar
    .lvl** (Ctrl+S); **Arquivo → Restaurar o .lvl original**.
  - **Texturas:** **Importar imagem…** (PNG/JPG de qualquer tamanho, ajustado para potência de 2 até 4096, maior ou menor
    que a original; DXT1/DXT5 comprimido no navegador; mipmaps refeitos quando a original tem, como na TTB) e
    **Restaurar original**. Recarregue a fase para ver a textura nova nela.
- Feche o jogo antes de gravar.
- **Extrair (só leitura):** Texturas → **Salvar PNG**; Modelos → **Exportar glTF (.glb)** (malha da LOD 0, texturas PNG,
  esqueleto com todos os pesos); Animação → **Exportar com o modelo (.glb)** (modelo escolhido + chaves exatas do `.adu`).
  Abre no Blender. Inserir modelos e animações ainda não existe: falta decodificar o resto do formato.

### Controles
Iguais aos do visor do Unreal Editor:
- **Botão direito + arrastar:** olhar · **direito + `W A S D`:** andar, `Q`/`E` desce/sobe, roda do mouse muda a velocidade (8 níveis), `Z`/`C` zoom
- **Esquerdo + arrastar:** girar e andar no plano · **meio** (ou esquerdo + direito): deslizar · **roda:** frente/trás
- **`Alt` + esquerdo:** orbitar · **`Alt` + direito:** aproximar/afastar · **`Alt` + meio:** deslizar
- **Setas / PageUp / PageDown:** andar sem o mouse · **`F`:** enquadrar a seleção · **`Shift`:** 3× mais rápido · clique simples: selecionar

### Organização do código
| Arquivo | Conteúdo |
|---|---|
| `RiotEditor.py` | inicia o servidor local e abre o navegador |
| `Riot/RiotContainer.py` | contêiner SRSC (todos os arquivos `.*du` e `.lvl`) |
| `Riot/RiotPackages.py` | detecção do jogo, pacotes (`.db`), referências e lista de fases |
| `Riot/RiotClasses.py` | classes de objeto (`.rfl` e tabela do motor no `.exe`) |
| `Riot/RiotTemplates.py` | templates de objeto (`.odu`) |
| `Riot/RiotMaterials.py` | materiais: textura e modo de mistura |
| `Riot/RiotTextures.py` | texturas (`.tdu`) |
| `Riot/RiotModels.py` | modelos (`.mdu`) |
| `Riot/RiotLevel.py` | fases (`.lvl`): instâncias, terreno, células, portais, histórico |
| `Riot/RiotProperties.py` | flags e propriedades das instâncias |
| `Riot/RiotLighting.py` | luz pré-calculada (`.ldu`) e Point Lights |
| `Riot/RiotEnvironment.py` | ambiente da fase: Level Properties → Sky Properties (neblina), switchers, névoa volumétrica |
| `Riot/RiotAnimations.py` | animações (`.adu`): cabeçalho, trilhas (TS1 e TTB), eventos e ligações |
| `Riot/RiotAssets.py` | abas Texturas, Modelos e Animação: listas por pacote, modelos com esqueleto, modelos compatíveis |
| `Riot/RiotRendering.py` | monta a cena para o visor 3D |
| `Riot/RiotServer.py` | servidor HTTP local (só 127.0.0.1) |
| `Editor/` | interface (HTML, CSS, JavaScript, three.js); câmera em `Editor/RiotCameraControls.js`, gizmos em `Editor/RiotGizmo.js` |
| `Docs/RiotEngineNotes.md` | todas as notas de engenharia reversa dos formatos |

Cada módulo começa com a documentação do formato que trata (campos, o que é confirmado e o endereço da função no `.exe`).

---

## English

### Setup
1. Install **Python 3.8+** (python.org, tick "Add Python to PATH"). No other libraries are needed.
2. Copy the whole **RiotTools** folder into the game folder, next to `Suffering.exe` or `SufferingTTB.exe`.
3. Double-click **`RiotTools\SurrealEd.bat`**. The editor opens in your browser (current Chrome, Edge or Firefox).
   Close the black window to quit.

If RiotTools lives elsewhere: `python RiotEditor.py --game "D:\Games\The Suffering"`.

### What works in this version (0.1)
- **Level tab:** opens any `.lvl` straight from the game files — terrain, objects, textures, baked lighting (`.ldu`),
  point lights, class filter, object picking, rooms/cells/portals/PVS, textured/untextured and wireframe modes, and
  normals drawn as lines (blue = vertex normal from the file, cyan = face normal) on the selected object or, with no
  selection, on objects near the camera target.
- **Properties panel** for the selected object: transform, flags (visible, casts dynamic shadow…) and every class
  property, with template values and the ones the instance overrides. Read-only for now.
- **Move, rotate and scale gizmos** (Unreal-style: `Q` select, `W` move, `E` rotate, `R` scale, space cycles,
  `` ` `` local/world), with grid snapping, undo/redo (`Ctrl+Z` / `Ctrl+Y`) and revert. Changes are written to the
  .lvl with **File → Save level** (`Ctrl+S`). Rotation snaps to whole degrees, as the game stores it.
- **Dynamic shadows** (World Settings → Lighting), as in game: casters by the effective flag (0x1000 → 0x400, else
  template flags bit 0), 256² silhouette from the strongest point light, elevation clamped to 45°, fade between Level
  Properties p14 and p15. Details lets you toggle an object's shadow (preview only, not saved).
- **Editable properties and lights:** in Details, each object's numbers, colours (UMG-style wheel), messages and
  references become fields; visible ones update live (point light colour, intensity and on/off relight the viewport)
  and everything is saved to the .lvl as instance overrides. Lists are still read-only.
- **Game fog** (Viewport rendering → Game fog): linear in depth, end = Sky Properties p2, start = p3 × p2, colour p4.
  World Settings makes the three fields editable with a live preview; "Save to template" writes the sky's .odu, which
  changes **every** level using that sky.
- **Animated materials** (Viewport rendering → Animate materials): Animating Material frames at their fps; Advanced
  Material UV scale/offset plus the `.wdu` scroll curve (water, smoke, sludge; TTB's `.wdu` header differs and is read
  too). Numeric properties get a slider; on/off ones a checkbox.
- **Copy, paste and delete objects** (Edit, or Ctrl+C / Ctrl+V / Ctrl+D / Del, with Ctrl+Z): the copy appears 1 m away
  (or one grid step) and is saved with a new id, a leaf in the cell tree (under the node whose box holds its position)
  and an editor-history row. Deleting is only saved when no link, object property, portal or STOMP track points at
  the object. Copies reuse the source's baked lighting.
- **STOMP in the level:** "Play in level (3D)" in the STOMP tab plays the sequence in the viewport: objects follow
  their keys, the Camera track drives the view (FOV and time scale), visibility, sounds and subtitles fire on time and
  other keys are logged. Untick "Scene camera" to watch from outside. Skinned characters and props play their animation
  keys (channel 0, with blending and locked/free root motion); partial-body channels are not played yet.
- **Lights and hidden objects:** every Point Light has a clickable icon (within 25 m of the camera); flag-0x8 objects
  (not created at level start) are hidden by default; tinted material passes are unlit and tinted, as in game;
  unbaked objects get the level's Ambient Light + Directional Light.
- **Level logic:** in Details, message properties are tagged input/output, message values are named (1 On,
  6 Triggered…) and the "Links" section shows what the object sends, to whom, and which messages each target actually
  hears (amber/blue lines in the viewport; click to go to the object). Both games' message maps were extracted from the
  .rfl files (`Ghidra/Atlas/RiotMessageMaps.py`, `Tools/RiotMessageNames.py`).
- **Asset tabs:** Textures, Models, Animation, **Audio** (waveform, lip-sync curve, subtitle, distances, save WAV),
  **STOMP** (sequences: tracks per level object, typed events, top view, playback with sounds, open the level at the
  object) and **Video** (save .wmv; MP4 preview when `ffmpeg` is on PATH).
- **Sky (skybox)** (Viewport rendering → Sky): Sky / Sun layers are drawn around the camera before the level; the
  dome (p6 = 1) shows the Sky Properties strip (p4 horizon, p5 sky, p6 band, p7 blend); clouds scroll.
- **Performance** (Viewport rendering → Performance): shows the GPU the browser is using (warns on software
  rendering: SwiftShader, llvmpipe, Microsoft Basic Render/WARP), FPS, logic and draw time and draw calls; internal
  resolution 100/75/50%. Off-screen meshes are culled. Adjustable icon size.
- **Level viewport**: header with the tools and the Blender-style **Transform** and **View** menus (numpad axis views,
  perspective/orthographic, display modes, advanced display, grid, info, frame time, half resolution, cinematic
  preview, focus origin, align object with view).
- **STOMP tab**: pick the level (set); the list shows the sequences of its folder that use its objects; the scene plays
  in the level's own 3D viewport with tracks and keys below. **Editable:** drag keys to retime, double-click to add,
  per-type value editing, <kbd>K</kbd> keys the pose (view camera or object), undo/redo, Save replaces only that
  sequence in the .qdu, "Back to original"; editable JSON export/import.
- **Material tab**: a package's materials as nodes (textures/frames/layers/.wdu curve → material → output) with a live
  preview; editable parameters; Save patches only the changed .odu slots; JSON export/import.
- **Scripting tab**: the level logic as nodes (objects, output/input messages, links); entry points on the right;
  link/unlink by dragging wires; edit messages; saved into the .lvl.
- **Strings tab**: .xdu texts, edit in place, TSV export/import, saves only what changed.
- **Saving from the original**: undoing every change gives the original file back byte for byte.
- **Textures tab**: W/S (or ↑/↓) move one grid row, A/D (or ←/→) one tile.
- **Particle effects** (Viewport rendering → Particle effects; `Editor/RiotParticles.js`, `Riot/RiotEffects.py`):
  TS1 Particle Fountain, Object Generator (the ones spawning fountains) and Billboard; TTB Particle System - Simple
  (meanings **inferred** from the TTB .rfl), Billboard Light Cone (read from SufferingTTB.exe code) and Billboard.
  Model-less effects get a clickable orange star icon.
  Message-triggered ones play when selected or with "Preview message-triggered effects".
- **Asset tab shortcuts** (Models, Animation, Audio, STOMP, Video): <kbd>W</kbd>/<kbd>S</kbd> (or arrows) move through the
  list, <kbd>Space</kbd> plays/stops. During a STOMP scene, editor markers and invisible collision are hidden.
- The UI starts in English; Portuguese is under **View → Português** (remembered by the browser).
- **Saving** (always backed up): the first time a file changes, the original goes to `SurrealEd Backup/` in the game
  folder (never overwritten). Containers are rewritten keeping the original layout; unchanged files come out
  byte-identical (`python Tools/RiotRoundTrip.py "<game folder>"` checks all 405 files).
  - **Level:** flags (except 0x10, 0x100, 0x8000, which change the record size) and transforms → **File → Save .lvl**
    (Ctrl+S); **File → Restore the original .lvl**.
  - **Textures:** **Import image…** (PNG/JPG of any size, resized to a power of two up to 4096, larger or smaller than the
    original; DXT1/DXT5 compressed in the browser; mipmaps rebuilt when the original has them, as in TTB) and **Restore
    original**. Reload the level to see the new texture there.
- Close the game before saving.
- **Extract (read-only):** Textures → **Save PNG**; Models → **Export glTF (.glb)** (LOD 0 mesh, PNG textures, skeleton
  with every weight); Animation → **Export with the model (.glb)** (chosen model + the exact `.adu` keys). Opens in
  Blender. Inserting models and animations is not available yet: the rest of the format still has to be decoded.

### Controls
Same as the Unreal Editor viewport:
- **Right drag:** look · **right + `W A S D`:** fly, `Q`/`E` down/up, mouse wheel changes speed (8 levels), `Z`/`C` zoom
- **Left drag:** turn and move on the ground · **middle** (or left + right): pan · **wheel:** forward/back
- **`Alt` + left:** orbit · **`Alt` + right:** dolly · **`Alt` + middle:** pan
- **Arrows / PageUp / PageDown:** move without the mouse · **`F`:** frame selection · **`Shift`:** 3× faster · plain click: select

### Code layout
See the table above; every module starts with the documentation of the format it handles (fields, what is confirmed
and the address of the matching function in the game executable). Full reverse-engineering notes: `Docs/RiotEngineNotes.md`.

---

Licença / License: MIT (see `LICENSE`). Fan project, not affiliated with Surreal Software, Midway or Warner Bros. No game data is included.

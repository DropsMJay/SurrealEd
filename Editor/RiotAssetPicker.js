/*
 * RiotAssetPicker — miniaturas e seletor de modelo/material / thumbnails and model/material picker
 *
 * PT: Usado pelo painel Details (seções Modelo e Materiais, no estilo do Unreal): miniatura do modelo (desenhada uma
 *     vez num renderizador escondido e guardada), miniatura da textura de um material, e uma janela flutuante com
 *     pacote + filtro + lista para escolher outro modelo ou material.
 * EN: Used by the Details panel (Model and Materials sections): model thumbnails (rendered once off-screen and cached),
 *     material texture thumbnails, and a floating picker (package + filter + list).
 */
const RiotAssetPicker = (() => {
  const Shared = () => RiotAssetTabs.Shared;
  const ModelThumbs = new Map(), TextureThumbs = new Map();
  let Renderer = null, Popup = null;

  /** PT: Miniatura (data URL) de um modelo. EN: Model thumbnail (data URL). */
  function ModelThumb(Code, Size = 96) {
    if (!Code) return Promise.resolve(null);
    if (ModelThumbs.has(Code)) return ModelThumbs.get(Code);
    const Job = (async () => {
      const Model = await Shared().FetchModel(Code);
      if (!Renderer) {
        Renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        Renderer.outputEncoding = THREE.sRGBEncoding;
      }
      Renderer.setSize(Size, Size, false);
      const Scene = new THREE.Scene();
      Scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.1));
      const Sun = new THREE.DirectionalLight(0xffffff, 0.8); Sun.position.set(2, 3, 4); Scene.add(Sun);
      Scene.add(Model.Root);
      const Box = new THREE.Box3().setFromObject(Model.Root);
      const Centre = Box.getCenter(new THREE.Vector3()), Radius = Math.max(0.05, Box.getSize(new THREE.Vector3()).length() / 2);
      const Camera = new THREE.PerspectiveCamera(35, 1, Radius / 100, Radius * 20);
      Camera.position.copy(Centre).add(new THREE.Vector3(1, 0.7, 1.3).normalize().multiplyScalar(Radius / Math.sin(THREE.MathUtils.degToRad(17.5)) * 1.05));
      Camera.lookAt(Centre);
      Renderer.render(Scene, Camera);
      const Url = Renderer.domElement.toDataURL('image/png');
      if (Model.Dispose) Model.Dispose();
      return Url;
    })().catch(() => null);
    ModelThumbs.set(Code, Job);
    return Job;
  }

  /** PT: Miniatura (data URL) de uma textura. EN: Texture thumbnail (data URL). */
  function TextureThumb(Code, Size = 64) {
    if (!Code) return Promise.resolve(null);
    if (TextureThumbs.has(Code)) return TextureThumbs.get(Code);
    const Job = (async () => {
      const Image_ = await Shared().TextureImage(Code);
      if (!Image_) return null;
      const Full = document.createElement('canvas');
      Full.width = Image_.width; Full.height = Image_.height;
      Full.getContext('2d').putImageData(Image_, 0, 0);
      const Small = document.createElement('canvas');
      Small.width = Small.height = Size;
      Small.getContext('2d').drawImage(Full, 0, 0, Size, Size);
      return Small.toDataURL('image/png');
    })().catch(() => null);
    TextureThumbs.set(Code, Job);
    return Job;
  }

  /** PT: <img> que se preenche quando a miniatura chega. EN: <img> filled when the thumbnail arrives. */
  function ThumbImage(Promise_, ClassName) {
    const Image_ = document.createElement('img');
    Image_.className = ClassName || 'AssetThumb';
    Image_.alt = '';
    Promise_.then(Url => { if (Url) Image_.src = Url; else Image_.classList.add('Missing'); });
    return Image_;
  }

  function Close() {
    if (!Popup) return;
    Popup.remove(); Popup = null;
    document.removeEventListener('pointerdown', Outside, true);
    document.removeEventListener('keydown', Escape, true);
  }
  function Outside(Event) { if (Popup && !Popup.contains(Event.target)) Close(); }
  function Escape(Event) { if (Event.key === 'Escape') { Event.stopPropagation(); Close(); } }

  /**
   * PT: Abre o seletor perto de Anchor. Kind: 'model' | 'material'. OnPick(ref) ao escolher.
   * EN: Opens the picker next to Anchor. Kind: 'model' | 'material'.
   */
  async function Open(Anchor, Kind, Current, OnPick) {
    Close();
    const { Make, FillPackageSelect, LoadPackages, SplitRef, Ui } = Shared();
    await LoadPackages();
    Popup = Make('div', 'AssetPicker');
    const Select = document.createElement('select');
    FillPackageSelect(Select, Kind === 'model' ? 'Models' : 'Textures', '');
    const CurrentPackage = Current ? String(SplitRef(Current)[0]) : null;
    if (CurrentPackage && [...Select.options].some(Option => Option.value === CurrentPackage)) Select.value = CurrentPackage;
    const Filter = document.createElement('input');
    Filter.placeholder = Text('PickerFilter');
    const List = Make('div', 'AssetPickerList');
    const Count = Make('div', 'AssetPickerCount');
    Popup.append(Select, Filter, Count, List);
    document.body.appendChild(Popup);
    const Box = Anchor.getBoundingClientRect();
    Popup.style.left = Math.max(8, Math.min(window.innerWidth - 340, Box.right - 330)) + 'px';
    Popup.style.top = Math.min(window.innerHeight - 420, Box.bottom + 4) + 'px';
    let Items = [];
    const Observer = new IntersectionObserver(Entries => {
      for (const Entry of Entries) if (Entry.isIntersecting && Entry.target.dataset.thumb) {
        const Holder = Entry.target, Code = Holder.dataset.thumb;
        delete Holder.dataset.thumb;
        Holder.prepend(ThumbImage(Kind === 'model' ? ModelThumb(Code, 64) : TextureThumb(Code, 48), 'AssetPickerThumb'));
        Observer.unobserve(Holder);
      }
    }, { root: List });
    const Render = () => {
      const Query = Filter.value.trim().toLowerCase();
      List.innerHTML = '';
      const Shown = Items.filter(Item => !Query || JSON.stringify(Item).toLowerCase().includes(Query)).slice(0, 400);
      for (const Item of Shown) {
        const Row = Make('button', 'AssetPickerRow' + (Item.Ref === Current ? ' Current' : ''));
        Row.type = 'button';
        Row.dataset.thumb = Kind === 'model' ? Item.Ref : (Item.Texture || '');
        const Text_ = Make('span', 'AssetPickerText');
        Text_.append(Make('b', null, Item.Ref), Make('small', null, Kind === 'model'
          ? `${(Item.Classes || []).slice(0, 2).join(', ') || '—'} · ${Item.Faces} faces`
          : `${Item.Class} · ${Item.Texture || '—'} · ${Item.Blend || ''}`));
        Row.appendChild(Text_);
        Row.addEventListener('click', () => { Close(); OnPick(Item.Ref); });
        List.appendChild(Row);
        if (Row.dataset.thumb) Observer.observe(Row);
      }
      Count.textContent = Text('AssetCount', { Shown: NumberText(Shown.length), Total: NumberText(Items.length) });
    };
    const Load = async () => {
      Count.textContent = Text('AssetLoading');
      const Data = await Ui().FetchJson((Kind === 'model' ? '/api/Models/' : '/api/Materials/') + Select.value);
      Items = Array.isArray(Data) ? Data : [];
      Render();
    };
    Select.addEventListener('change', Load);
    Filter.addEventListener('input', Render);
    setTimeout(() => { document.addEventListener('pointerdown', Outside, true); document.addEventListener('keydown', Escape, true); Filter.focus(); }, 0);
    await Load();
  }

  return { ModelThumb, TextureThumb, ThumbImage, Open, Close };
})();

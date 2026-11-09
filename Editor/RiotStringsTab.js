/*
 * RiotStringsTab — aba Strings: textos dos .xdu / Strings tab: .xdu texts
 *
 * PT: Lista os textos de um pacote (.xdu, pedaço 0x0400 = u16 tamanho + UTF-16LE com terminador), edita no lugar,
 *     exporta/importa como TSV (Ref <tab> Texto; quebra de linha = \n, tab = \t, barra = \\) e grava só os textos que
 *     mudaram (o resto do .xdu fica idêntico; backup do original na primeira vez).
 * EN: Lists a package's strings, edits them in place, exports/imports TSV (Ref <tab> Text with \n, \t, \\ escapes) and
 *     saves only the changed strings (the rest of the .xdu stays identical; original backed up on first save).
 */
(() => {
  const $ = Id => document.getElementById(Id);
  const { Make, Remember } = RiotAssetTabs.Shared;
  const Ui = () => RiotAssetTabs.Shared.Ui();
  const Escape = Text => Text.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n');
  const Unescape = Text => Text.replace(/\\(\\|t|n)/g, (_Match, Code) => (Code === 'n' ? '\n' : Code === 't' ? '\t' : '\\'));

  const StringsTab = {
    Package: null, List: [], Changes: new Map(),

    Open() { if (!this.Opening) this.Opening = this.OpenOnce(); return this.Opening; },

    async OpenOnce() {
      const Packages = await Ui().FetchJson('/api/StringPackages');
      const Select = $('StringsPackage');
      for (const Package of Packages) {
        const Option = document.createElement('option');
        Option.value = Package.Id;
        Option.textContent = `${Package.Name} (${Package.Id}) · ${Package.Count}`;
        Option.title = Package.Folder;
        Select.appendChild(Option);
      }
      if (!Packages.length) { $('StringsCount').textContent = Text('MediaNone'); return; }
      Select.addEventListener('change', () => this.Load());
      $('StringsFilter').addEventListener('input', () => this.Render());
      $('StringsExport').addEventListener('click', () => this.Export());
      $('StringsImport').addEventListener('click', () => $('StringsFile').click());
      $('StringsFile').addEventListener('change', () => this.Import($('StringsFile').files[0]));
      $('StringsSave').addEventListener('click', () => this.Save());
      $('StringsRevert').addEventListener('click', () => { this.Changes.clear(); this.Render(); });
      const Wanted = Remember('StringsPackage');
      if (Wanted && Packages.some(Package => String(Package.Id) === Wanted)) Select.value = Wanted;
      await this.Load();
    },

    async Load() {
      if (this.Changes.size && !window.confirm(Text('StringsDiscard'))) { $('StringsPackage').value = String(this.Package); return; }
      this.Package = Number($('StringsPackage').value);
      Remember('StringsPackage', String(this.Package));
      this.Changes.clear();
      $('StringsCount').textContent = Text('AssetLoading');
      const List = await Ui().FetchJson('/api/Strings/' + this.Package);
      this.List = List.Error ? [] : List;
      this.Render();
    },

    Current(Item) { return this.Changes.has(Item.Index) ? this.Changes.get(Item.Index) : Item.Text; },

    Render() {
      const Query = $('StringsFilter').value.trim().toLowerCase();
      const Table = $('StringsTable');
      Table.innerHTML = '';
      const Shown = this.List.filter(Item => !Query || `${Item.Ref} ${this.Current(Item)}`.toLowerCase().includes(Query));
      for (const Item of Shown.slice(0, 4000)) {
        const Row = Make('div', 'StringRow' + (this.Changes.has(Item.Index) ? ' Edited' : ''));
        const Box = document.createElement('textarea');
        Box.value = this.Current(Item);
        Box.rows = Math.min(8, Math.max(1, Box.value.split('\n').length));
        Box.spellcheck = false;
        Box.setAttribute('aria-label', Item.Ref);
        Box.addEventListener('input', () => {
          if (Box.value === Item.Text) this.Changes.delete(Item.Index); else this.Changes.set(Item.Index, Box.value);
          Row.classList.toggle('Edited', this.Changes.has(Item.Index));
          Box.rows = Math.min(8, Math.max(1, Box.value.split('\n').length));
          this.SyncButtons();
        });
        Row.append(Make('span', 'StringRef', Item.Ref), Box);
        Table.appendChild(Row);
      }
      $('StringsCount').textContent = Text('AssetCount', { Shown: NumberText(Shown.length), Total: NumberText(this.List.length) });
      this.SyncButtons();
    },

    SyncButtons() {
      $('StringsSave').disabled = !this.Changes.size;
      $('StringsRevert').disabled = !this.Changes.size;
      $('StringsChanged').textContent = this.Changes.size ? Text('StringsChanged', { Count: this.Changes.size }) : '';
    },

    Export() {
      const Lines = this.List.map(Item => `${Item.Ref}\t${Escape(this.Current(Item))}`);
      const Blob_ = new Blob(['﻿' + Lines.join('\r\n') + '\r\n'], { type: 'text/tab-separated-values;charset=utf-8' });
      const Link = document.createElement('a');
      Link.href = URL.createObjectURL(Blob_);
      const Option = $('StringsPackage').selectedOptions[0];
      Link.download = `${(Option ? Option.textContent.split(' (')[0] : this.Package)}_${this.Package}.tsv`;
      document.body.appendChild(Link);
      Link.click();
      setTimeout(() => { URL.revokeObjectURL(Link.href); Link.remove(); }, 1000);
    },

    async Import(File) {
      if (!File) return;
      const Text_ = (await File.text()).replace(/^﻿/, '');
      const ByRef = new Map(this.List.map(Item => [Item.Ref, Item]));
      let Matched = 0, Unknown = 0;
      for (const Line of Text_.split(/\r?\n/)) {
        if (!Line.trim()) continue;
        const Tab = Line.indexOf('\t');
        const Item = Tab > 0 ? ByRef.get(Line.slice(0, Tab).trim()) : null;
        if (!Item) { Unknown++; continue; }
        const Value = Unescape(Line.slice(Tab + 1));
        if (Value === Item.Text) this.Changes.delete(Item.Index); else this.Changes.set(Item.Index, Value);
        Matched++;
      }
      $('StringsFile').value = '';
      this.Render();
      Ui().SetStatus(Text('StringsImported', { Matched, Changed: this.Changes.size, Unknown }));
    },

    async Save() {
      if (!this.Changes.size) return;
      const Body = { Strings: Object.fromEntries(this.Changes) };
      let Result;
      try {
        const Response = await fetch('/api/SaveStrings/' + this.Package, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Body) });
        Result = await Response.json();
      } catch (Error) { Result = { Error: String(Error) }; }
      if (Result.Error) { Ui().SetStatus(Text('SaveFailed', { Error: Result.Error })); return; }
      for (const Item of this.List) if (this.Changes.has(Item.Index)) Item.Text = this.Changes.get(Item.Index);
      this.Changes.clear();
      this.Render();
      Ui().SetStatus(Text('StringsSaved', { Count: Result.Saved, Backup: Result.Backup || '—' }));
    },

    Relabel() { if (this.List.length) this.Render(); },
    Show(Active) { if (Active) this.Open(); },
  };

  RiotAssetTabs.Register('Strings', StringsTab);
})();

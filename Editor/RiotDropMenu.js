/*
 * RiotDropMenu — menus suspensos do cabeçalho do visor / viewport header drop-down menus
 *
 * PT: Um menu é uma lista de itens montada na hora em que abre (assim as marcas refletem o estado atual):
 *       { Label, Key, Run }                      ação
 *       { Label, Key, Kind: 'check', Checked, Run }   liga/desliga
 *       { Label, Key, Kind: 'radio', Checked, Run }   escolha única
 *       { Kind: 'sep' }                          separador
 *       { Label, Items: () => [...] }            submenu (abre ao passar o mouse)
 *     Disabled (função) apaga o item; Tip vira a dica do item.
 * EN: A menu is a list of items built when it opens, so checks show the current state (see the list above).
 */
class RiotDropMenu {
  constructor(Element) {
    this.Element = Element;
    this.Anchor = null;
    this.Sub = null;
    this.Builder = null;
    document.addEventListener('pointerdown', Event => {
      if (this.Element.hidden) return;
      if (this.Element.contains(Event.target) || (this.Sub && this.Sub.contains(Event.target)) || (this.Anchor && this.Anchor.contains(Event.target))) return;
      this.Close();
    });
    document.addEventListener('keydown', Event => { if (Event.key === 'Escape') this.Close(); });
  }

  get IsOpen() { return !this.Element.hidden; }

  Toggle(Anchor, Builder) {
    if (this.IsOpen && this.Anchor === Anchor) { this.Close(); return; }
    this.Open(Anchor, Builder);
  }

  Open(Anchor, Builder) {
    this.Anchor = Anchor;
    this.Builder = Builder;
    this.Render();
    // PT: posição relativa ao contêiner do menu (posicionado) / EN: position relative to the menu's container
    const Parent = this.Element.parentElement;
    const Box = Anchor.getBoundingClientRect(), Frame = Parent.getBoundingClientRect();
    this.Element.style.left = `${Math.max(4, Box.left - Frame.left)}px`;
    this.Element.style.top = `${Box.bottom - Frame.top + 2}px`;
    this.Element.hidden = false;
    // PT: não deixa o menu passar da borda de baixo / EN: keep the menu inside the bottom edge
    const Room = Frame.height - (Box.bottom - Frame.top) - 8;
    this.Element.style.maxHeight = `${Math.max(160, Room)}px`;
    Anchor.setAttribute('aria-expanded', 'true');
  }

  Close() {
    if (this.Anchor) this.Anchor.setAttribute('aria-expanded', 'false');
    this.Element.hidden = true;
    this.CloseSub();
  }

  CloseSub() {
    if (this.Sub) { this.Sub.remove(); this.Sub = null; }
  }

  Render() {
    this.Element.innerHTML = '';
    this.CloseSub();
    this.Fill(this.Element, this.Builder(), true);
  }

  Fill(Container, Items, IsRoot) {
    for (const Item of Items) {
      if (Item.Kind === 'sep') { Container.appendChild(Object.assign(document.createElement('div'), { className: 'DropSep' })); continue; }
      const Row = document.createElement('button');
      Row.type = 'button';
      Row.className = 'DropItem' + (Item.Kind ? ' ' + Item.Kind : '') + (Item.Items ? ' HasSub' : '');
      Row.setAttribute('role', Item.Kind === 'check' ? 'menuitemcheckbox' : Item.Kind === 'radio' ? 'menuitemradio' : 'menuitem');
      const Checked = Item.Checked ? Boolean(Item.Checked()) : false;
      if (Item.Kind) Row.setAttribute('aria-checked', String(Checked));
      const Disabled = Item.Disabled ? Boolean(Item.Disabled()) : false;
      Row.disabled = Disabled;
      if (Item.Tip) Row.title = Item.Tip;
      const Mark = document.createElement('span');
      Mark.className = 'DropMark';
      const Label = document.createElement('span');
      Label.className = 'DropLabel';
      Label.textContent = Item.Label;
      const Key = document.createElement('span');
      Key.className = 'DropKey';
      Key.textContent = Item.Items ? '›' : (Item.Key || '');
      Row.append(Mark, Label, Key);
      if (Item.Items) {
        Row.addEventListener('pointerenter', () => this.OpenSub(Row, Item.Items));
        Row.addEventListener('click', Event => { Event.stopPropagation(); this.OpenSub(Row, Item.Items); });
      } else {
        if (IsRoot) Row.addEventListener('pointerenter', () => this.CloseSub());
        Row.addEventListener('click', Event => {
          Event.stopPropagation();
          if (Item.Run) Item.Run();
          // PT: liga/desliga deixa o menu aberto (como no Blender) / EN: toggles keep the menu open
          if (Item.Kind === 'check' || Item.Kind === 'radio') this.Render(); else this.Close();
        });
      }
      Container.appendChild(Row);
    }
  }

  OpenSub(Row, Builder) {
    this.CloseSub();
    const Sub = document.createElement('div');
    Sub.className = 'DropMenu Sub';
    this.Fill(Sub, Builder(), false);
    this.Element.parentElement.appendChild(Sub);
    const Parent = this.Element.parentElement;
    const Box = Row.getBoundingClientRect(), Frame = Parent.getBoundingClientRect();
    Sub.style.left = `${Box.right - Frame.left + 2}px`;
    Sub.style.top = `${Box.top - Frame.top - 4}px`;
    this.Sub = Sub;
  }
}

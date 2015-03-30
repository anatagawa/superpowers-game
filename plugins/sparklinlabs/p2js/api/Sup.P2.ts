module Sup {
  export module P2 {
    export function getWorld() { return SupEngine.P2.World; }
    export function resetWorld() { SupEngine.P2.World = new window.p2.World(); }
    export function getWorldAutoUpdate() { return SupEngine.P2.autoUpdate; }
    export function setWorldAutoUpdate(autoUpdate) { SupEngine.P2.autoUpdate = autoUpdate; }

    export class Body extends ActorComponent {
      body: any;

      constructor( actor, options ) {
        super( actor );
        this.__inner = new SupEngine.componentClasses.P2Body( actor.__inner, options );
        this.__inner.__outer = this;
        this.body = this.__inner.body;
        this.actor.p2Body = this;
      }
      destroy() {
        this.body = null;
        this.actor.p2Body = null;
        super.destroy();
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/events" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/pic/")) {
      const id = env.CHATROOM.idFromName("global-chat");
      return env.CHATROOM.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.clients = new Map();
    this.lastSent = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/events") return this.openEvents(url);
    if (request.method === "GET" && url.pathname.startsWith("/pic/")) return this.getPic(url.pathname.slice(5));
    if (request.method === "POST" && url.pathname.startsWith("/api/")) return this.api(request, url.pathname);
    return new Response("Not found", { status: 404 });
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  }

  async readUser(tk, create = true) {
    if (!tk || tk.length > 200) return null;
    let user = await this.ctx.storage.get("token:" + tk);
    if (!user && create) {
      user = {
        id: crypto.randomUUID(),
        n: "ผู้ใช้" + Math.floor(100 + Math.random() * 900),
        d: null,
        pv: 0,
        created: Date.now()
      };
      await this.ctx.storage.put("token:" + tk, user);
      await this.ctx.storage.put("user:" + user.id, user);
    }
    return user || null;
  }

  async saveUser(user) {
    await this.ctx.storage.put("user:" + user.id, user);
    // Token lookup is updated by callers when the token is known.
  }

  async isAdmin(urlOrBody) {
    const supplied = urlOrBody.ak || "";
    const secret = this.env.ADMIN_KEY || "";
    return !!secret && supplied === secret;
  }

  async readJson(request) {
    try { return await request.json(); } catch { return {}; }
  }

  async getList(prefix, limit = 150) {
    const entries = await this.ctx.storage.list({ prefix, reverse: true, limit });
    return Array.from(entries.values()).reverse();
  }

  async history(room) {
    return this.getList("msg:" + room + ":", 150);
  }

  async dmsFor(uid) {
    return this.getList("dm:" + uid + ":", 100);
  }

  async onlinePeople() {
    const people = [];
    for (const uid of this.clients.keys()) {
      const p = await this.ctx.storage.get("user:" + uid);
      if (p) people.push({ id: p.id, n: p.n, d: p.d, pv: p.pv || 0, adm: !!p.adm, bot: false });
    }
    return people;
  }

  async bansObject() {
    const entries = await this.ctx.storage.list({ prefix: "ban:" });
    const out = {};
    for (const [key, value] of entries) out[key.slice(4)] = value;
    return out;
  }

  event(controller, name, data) {
    try { controller.enqueue(new TextEncoder().encode("event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n")); }
    catch {}
  }

  async broadcast(name, data) {
    for (const controller of this.clients.values()) this.event(controller, name, data);
  }

  async updatePeople() {
    await this.broadcast("people", await this.onlinePeople());
  }

  async openEvents(url) {
    const tk = url.searchParams.get("tk") || "";
    if (!tk) return new Response("Missing token", { status: 400 });
    const user = await this.readUser(tk, true);
    const admin = await this.isAdmin({ ak: url.searchParams.get("ak") || "" });
    user.adm = admin;
    await this.ctx.storage.put("token:" + tk, user);
    await this.saveUser(user);
    const [general, checkpoint, dms, announce, bans] = await Promise.all([
      this.history("general"),
      this.history("checkpoint"),
      this.dmsFor(user.id),
      this.ctx.storage.get("announce"),
      this.bansObject()
    ]);
    const banUntil = await this.ctx.storage.get("ban:" + user.id) || 0;

    let streamController;
    const stream = new ReadableStream({
      start: controller => { streamController = controller; },
      cancel: () => {
        if (this.clients.get(user.id) === streamController) {
          this.clients.delete(user.id);
          this.updatePeople();
        }
      }
    });
    const old = this.clients.get(user.id);
    if (old) { try { old.close(); } catch {} }
    this.clients.set(user.id, streamController);
    this.event(streamController, "init", {
      me: { id: user.id, admin, ban: banUntil, pv: user.pv || 0 },
      msgs: { general, checkpoint },
      people: await this.onlinePeople(),
      dms, announce: announce || null, bans
    });
    await this.updatePeople();

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  }

  async getPic(uid) {
    const data = await this.ctx.storage.get("pic:" + uid);
    if (!data || typeof data !== "string" || !data.startsWith("data:image/")) return new Response("Not found", { status: 404 });
    const match = data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return new Response("Invalid image", { status: 404 });
    const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { "content-type": match[1], "cache-control": "public, max-age=300" } });
  }

  async api(request, path) {
    const body = await this.readJson(request);
    const tk = body.tk || "";
    const user = await this.readUser(tk, true);
    if (!user) return this.json({ error: "invalid_token" }, 401);
    const admin = await this.isAdmin(body);
    user.adm = admin;
    await this.ctx.storage.put("token:" + tk, user);
    await this.saveUser(user);

    if (path === "/api/presence") {
      const d = Number(body.d);
      if (!Number.isInteger(d) || d < 0 || d > 2) return this.json({ error: "invalid_district" }, 400);
      user.d = d;
      if (typeof body.n === "string" && body.n.trim()) user.n = body.n.trim().slice(0, 12);
      await this.ctx.storage.put("token:" + tk, user);
      await this.saveUser(user);
      await this.updatePeople();
      return this.json({ ok: true, pv: user.pv || 0 });
    }

    if (path === "/api/pic") {
      if (typeof body.pic !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(body.pic) || body.pic.length > 100000) {
        return this.json({ error: "invalid_image" }, 400);
      }
      user.pv = (user.pv || 0) + 1;
      await this.ctx.storage.put("pic:" + user.id, body.pic);
      await this.ctx.storage.put("token:" + tk, user);
      await this.saveUser(user);
      await this.updatePeople();
      return this.json({ ok: true, pv: user.pv });
    }

    if (path === "/api/send" || path === "/api/dm") {
      const now = Date.now();
      const last = this.lastSent.get(user.id) || 0;
      if (now - last < 650) return this.json({ error: "rate_limited" }, 429);
      this.lastSent.set(user.id, now);
      const banUntil = await this.ctx.storage.get("ban:" + user.id) || 0;
      if (banUntil > now) return this.json({ error: "banned", until: banUntil }, 403);

      const kind = body.k;
      if (!["t", "i", "v"].includes(kind)) return this.json({ error: "invalid_kind" }, 400);
      const message = {
        u: user.id, n: user.n, d: user.d, r: body.r === "checkpoint" ? "checkpoint" : "general",
        k: kind, ts: now, pv: user.pv || 0, adm: admin
      };
      if (kind === "t") {
        if (typeof body.t !== "string" || !body.t.trim() || body.t.length > 200) return this.json({ error: "invalid_text" }, 400);
        message.t = body.t.trim();
      } else if (kind === "i") {
        if (typeof body.im !== "string" || !body.im.startsWith("data:image/") || body.im.length > 195000) return this.json({ error: "invalid_image" }, 400);
        message.im = body.im;
      } else {
        if (typeof body.au !== "string" || !body.au.startsWith("data:audio/") || body.au.length > 225000) return this.json({ error: "invalid_audio" }, 400);
        message.au = body.au;
        message.dur = Math.min(15, Math.max(1, Number(body.dur) || 1));
      }

      if (path === "/api/send") {
        if (![0, 1, 2].includes(user.d)) return this.json({ error: "choose_district" }, 400);
        const key = "msg:" + message.r + ":" + String(now).padStart(16, "0") + ":" + crypto.randomUUID();
        await this.ctx.storage.put(key, message);
        await this.broadcast("msg", message);
        return this.json({ ok: true });
      }

      const target = String(body.to || "");
      if (!target || target === user.id) return this.json({ error: "invalid_recipient" }, 400);
      const recipient = await this.ctx.storage.get("user:" + target);
      if (!recipient) return this.json({ error: "recipient_not_found" }, 404);
      const dm = {
        ...message, a: user.id, b: target, an: user.n,
        ts: now, r: undefined
      };
      const suffix = String(now).padStart(16, "0") + ":" + crypto.randomUUID();
      await this.ctx.storage.put("dm:" + user.id + ":" + suffix, dm);
      await this.ctx.storage.put("dm:" + target + ":" + suffix, dm);
      this.event(this.clients.get(user.id), "dm", dm);
      this.event(this.clients.get(target), "dm", dm);
      return this.json({ ok: true });
    }

    if (path === "/api/ban") {
      if (!admin) return this.json({ error: "admin_required" }, 403);
      const target = String(body.target || "");
      if (!target || target === user.id) return this.json({ error: "invalid_target" }, 400);
      const mins = Math.max(0, Math.min(10080, Number(body.mins) || 0));
      const until = mins ? Date.now() + mins * 60000 : 0;
      if (until) await this.ctx.storage.put("ban:" + target, until);
      else await this.ctx.storage.delete("ban:" + target);
      const targetController = this.clients.get(target);
      if (targetController) this.event(targetController, "ban", { until });
      await this.broadcast("bans", await this.bansObject());
      return this.json({ ok: true });
    }

    if (path === "/api/announce") {
      if (!admin) return this.json({ error: "admin_required" }, 403);
      const text = typeof body.t === "string" ? body.t.trim().slice(0, 300) : "";
      const announcement = text ? { t: text, ts: Date.now() } : null;
      if (announcement) await this.ctx.storage.put("announce", announcement);
      else await this.ctx.storage.delete("announce");
      await this.broadcast("announce", announcement);
      return this.json({ ok: true });
    }

    return this.json({ error: "not_found" }, 404);
  }
}

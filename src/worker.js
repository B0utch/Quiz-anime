// Quiz « Devine l'animé » : serveur Cloudflare (Worker + Durable Object)
import { DurableObject } from 'cloudflare:workers';
import { ANIMES } from './questions.js';

// Codes d'accès. Tu peux les changer ici, puis relancer « npx wrangler deploy ».
// (En local, HOST_CODE peut aussi venir du fichier .dev.vars.)
const CODE_HOTE = '314159';
const MOT_DE_PASSE_MASTER = 'lustalia';

const PAR_ID = new Map(ANIMES.map((a) => [a.id, a]));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('WebSocket attendu', { status: 426 });
      }
      const stub = env.GAME.get(env.GAME.idFromName('partie'));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

// ---------- Outils texte ----------

export function normaliser(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/½/g, ' 1 2 ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(l|le|la|les|the) /, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function clesDe(anime) {
  return [anime.title, ...anime.keys].map(normaliser).filter(Boolean);
}

// Une réponse est juste si elle correspond à une des clés, avec une petite tolérance aux fautes.
export function estJuste(texte, anime) {
  const n = normaliser(texte);
  if (!n) return false;
  const compact = n.replace(/ /g, '');
  for (const k of clesDe(anime)) {
    const kc = k.replace(/ /g, '');
    if (compact === kc) return true;
    if (kc.length >= 4 && (' ' + n + ' ').includes(' ' + k + ' ')) return true;
    const tol = kc.length >= 12 ? 2 : kc.length >= 6 ? 1 : 0;
    if (tol && Math.abs(compact.length - kc.length) <= tol && levenshtein(compact, kc) <= tol) return true;
  }
  return false;
}

// Recherche tolérante aux fautes pour « Choisir un animé ».
function rechercher(q) {
  const n = normaliser(q).replace(/ /g, '');
  if (!n) return [];
  const notes = ANIMES.map((a) => {
    let best = Infinity;
    for (const k of clesDe(a)) {
      const kc = k.replace(/ /g, '');
      let d;
      if (kc === n) d = 0;
      else if (kc.startsWith(n) || (n.length >= 3 && kc.includes(n))) d = 0.5;
      else d = levenshtein(n, kc) / Math.max(n.length, kc.length);
      if (d < best) best = d;
    }
    return { a, d: best };
  });
  return notes
    .filter((x) => x.d <= 0.45)
    .sort((x, y) => x.d - y.d)
    .slice(0, 6)
    .map((x) => ({ id: x.a.id, title: x.a.title, exact: x.d <= 0.2 }));
}

function melanger(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nouvelEtat() {
  return {
    phase: 'lobby', // lobby | question | correction | reveal | end | battle
    settings: { difficulty: 'facile', count: 10, timer: 45, timeout: 5 },
    players: {}, // id -> { id, name, score, manual, connected, lastSeen }
    selection: [],
    picked: [],
    removed: [],
    order: [],
    qIndex: -1,
    current: null, // { animeId, level, deadline, answers: { pid: { text, ok, manual } } }
    history: [],
    battle: null,
    masterBlocked: false,
  };
}

const NIVEAUX = ['facile', 'difficile', 'crescendo'];

// ---------- La partie (Durable Object) ----------

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    try {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    } catch (e) {}
    ctx.blockConcurrencyWhile(async () => {
      this.s = Object.assign(nouvelEtat(), (await ctx.storage.get('state')) || {});
      this.images = (await ctx.storage.get('images')) || {};
      this.syncConnexions();
      await this.planifier();
    });
  }

  get codeHote() {
    return String(this.env.HOST_CODE || CODE_HOTE);
  }
  get codeMaster() {
    return String(this.env.MASTER_CODE || MOT_DE_PASSE_MASTER);
  }

  async fetch(req) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: 'anon' });
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets() {
    return this.ctx.getWebSockets().map((ws) => {
      let att = {};
      try {
        att = ws.deserializeAttachment() || {};
      } catch (e) {}
      return { ws, att };
    });
  }

  // Remet à jour qui est connecté (utile après un redémarrage du serveur).
  syncConnexions(exclure) {
    const enLigne = new Set();
    for (const { ws, att } of this.sockets()) {
      if (ws === exclure) continue;
      if (att.role === 'player' && att.pid) enLigne.add(att.pid);
    }
    const now = Date.now();
    for (const p of Object.values(this.s.players)) {
      if (p.manual) {
        p.connected = false;
        continue;
      }
      const c = enLigne.has(p.id);
      if (!c && p.connected) p.lastSeen = now;
      if (!c && !p.lastSeen) p.lastSeen = now;
      p.connected = c;
    }
  }

  async sauver() {
    await this.ctx.storage.put('state', this.s);
  }

  async planifier() {
    const t = [];
    if (this.s.phase === 'question' && this.s.current && this.s.current.deadline) t.push(this.s.current.deadline);
    const to = this.s.settings.timeout;
    if (to > 0) {
      for (const p of Object.values(this.s.players)) {
        if (!p.manual && !p.connected) t.push((p.lastSeen || Date.now()) + to * 60000);
      }
    }
    if (t.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 200, Math.min(...t)));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const now = Date.now();
    if (this.s.phase === 'question' && this.s.current && this.s.current.deadline && now >= this.s.current.deadline - 100) {
      this.s.phase = 'correction';
    }
    this.retirerAbsents(now);
    await this.valider();
  }

  retirerAbsents(now) {
    const to = this.s.settings.timeout;
    if (!(to > 0)) return;
    for (const p of Object.values(this.s.players)) {
      if (!p.manual && !p.connected && now - (p.lastSeen || now) >= to * 60000) this.supprimerJoueur(p.id);
    }
  }

  supprimerJoueur(pid) {
    delete this.s.players[pid];
    if (this.s.current && this.s.current.answers) delete this.s.current.answers[pid];
    const b = this.s.battle;
    if (b && b.players.includes(pid) && !b.winner) {
      b.players = b.players.filter((x) => x !== pid);
      delete b.points[pid];
      delete b.attempts[pid];
      if (b.players.length === 1) {
        b.winner = b.players[0];
        b.stage = 'done';
      } else if (b.players.length === 0) {
        b.stage = 'done';
      }
    }
  }

  async valider() {
    await this.sauver();
    await this.planifier();
    this.diffuser();
  }

  envoyer(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {}
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'player') {
      this.syncConnexions(ws);
      await this.valider();
    } else if (att.role === 'master') {
      this.diffuser(ws);
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async webSocketMessage(ws, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch (e) {
      return;
    }
    const att = ws.deserializeAttachment() || { role: 'anon' };
    try {
      await this.traiter(ws, att, m);
    } catch (e) {
      this.envoyer(ws, { t: 'error', msg: 'Erreur : ' + (e && e.message) });
    }
  }

  async traiter(ws, att, m) {
    const s = this.s;
    const admin = att.role === 'host' || att.role === 'master';

    // --- Connexions ---
    if (m.t === 'hello') {
      if (m.role === 'screen') {
        ws.serializeAttachment({ role: 'screen' });
        return this.envoyerVue(ws);
      }
      if (m.role === 'player') {
        if (m.pid && s.players[m.pid] && !s.players[m.pid].manual) {
          ws.serializeAttachment({ role: 'player', pid: m.pid });
          this.syncConnexions();
          return this.valider();
        }
        ws.serializeAttachment({ role: 'player' });
        return this.envoyerVue(ws);
      }
      return;
    }
    if (m.t === 'auth') {
      if (m.role === 'host' && String(m.code) === this.codeHote) {
        ws.serializeAttachment({ role: 'host' });
        this.envoyer(ws, { t: 'auth', ok: true, role: 'host' });
        return this.diffuser();
      }
      if (m.role === 'master' && String(m.code) === this.codeMaster) {
        if (s.masterBlocked) return this.envoyer(ws, { t: 'auth', ok: false, msg: "L'accès master est bloqué par l'hôte." });
        ws.serializeAttachment({ role: 'master' });
        this.envoyer(ws, { t: 'auth', ok: true, role: 'master' });
        return this.diffuser();
      }
      return this.envoyer(ws, { t: 'auth', ok: false, msg: 'Code incorrect.' });
    }
    if (m.t === 'join') {
      const name = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
      if (!name) return this.envoyer(ws, { t: 'error', msg: 'Choisis un pseudo.' });
      const existant = Object.values(s.players).find((p) => normaliser(p.name) === normaliser(name));
      let pid;
      if (existant) {
        if (existant.connected) return this.envoyer(ws, { t: 'error', msg: 'Ce pseudo est déjà pris.' });
        existant.manual = false;
        pid = existant.id;
      } else {
        if (Object.keys(s.players).length >= 60) return this.envoyer(ws, { t: 'error', msg: 'La partie est pleine.' });
        pid = crypto.randomUUID();
        s.players[pid] = { id: pid, name, score: 0, manual: false, connected: true, lastSeen: Date.now() };
      }
      ws.serializeAttachment({ role: 'player', pid });
      this.syncConnexions();
      this.envoyer(ws, { t: 'joined', pid });
      return this.valider();
    }

    // --- Joueur ---
    if (att.role === 'player' && att.pid && s.players[att.pid]) {
      const pid = att.pid;
      if (m.t === 'answer') {
        const texte = String(m.text || '').slice(0, 80).trim();
        if (!texte) return;
        if (s.phase === 'question' && s.current) {
          const a = PAR_ID.get(s.current.animeId);
          s.current.answers[pid] = { text: texte, ok: estJuste(texte, a), manual: false };
          return this.valider();
        }
        if (s.phase === 'battle') return this.tentativeBataille(pid, texte);
        return;
      }
      if (m.t === 'leave') {
        this.supprimerJoueur(pid);
        ws.serializeAttachment({ role: 'player' });
        return this.valider();
      }
      return;
    }

    if (!admin) return;

    // --- Hôte et master ---
    switch (m.t) {
      case 'settings': {
        const st = s.settings;
        if (s.phase === 'lobby') {
          if (NIVEAUX.includes(m.difficulty)) st.difficulty = m.difficulty;
          if ([5, 10, 15, 20, 30].includes(+m.count)) st.count = +m.count;
        }
        if ([0, 20, 30, 45, 60, 90].includes(+m.timer)) st.timer = +m.timer;
        if ([0, 1, 2, 5].includes(+m.timeout)) st.timeout = +m.timeout;
        return this.valider();
      }
      case 'draw': {
        if (s.phase !== 'lobby') return;
        this.tirage();
        return this.valider();
      }
      case 'pick': {
        if (s.phase !== 'lobby' || !PAR_ID.has(m.id)) return;
        const etait = s.removed.includes(m.id);
        s.removed = s.removed.filter((x) => x !== m.id);
        const deja = s.selection.includes(m.id);
        if (!deja) s.selection.push(m.id);
        if (!s.picked.includes(m.id)) s.picked.push(m.id);
        this.envoyer(ws, {
          t: 'toast',
          msg: deja
            ? `${PAR_ID.get(m.id).title} est déjà dans la partie.`
            : `${PAR_ID.get(m.id).title} ajouté${etait ? ' (il avait été retiré, il est remis)' : ''}.`,
        });
        return this.valider();
      }
      case 'unpick': {
        if (s.phase !== 'lobby') return;
        s.selection = s.selection.filter((x) => x !== m.id);
        s.picked = s.picked.filter((x) => x !== m.id);
        if (!s.removed.includes(m.id)) s.removed.push(m.id);
        return this.valider();
      }
      case 'search': {
        const res = rechercher(m.q).map((r) => ({ ...r, inGame: s.selection.includes(r.id), removed: s.removed.includes(r.id) }));
        return this.envoyer(ws, { t: 'search', q: m.q, results: res });
      }
      case 'start': {
        if (s.phase !== 'lobby') return;
        if (!s.selection.length) this.tirage();
        s.order = melanger(s.selection);
        s.history = [];
        s.battle = null;
        for (const p of Object.values(s.players)) p.score = 0;
        s.qIndex = -1;
        this.questionSuivante();
        return this.valider();
      }
      case 'close': {
        if (s.phase !== 'question') return;
        s.phase = 'correction';
        return this.valider();
      }
      case 'judge': {
        if (!s.current || !['question', 'correction', 'reveal'].includes(s.phase)) return;
        const a = s.current.answers[m.pid];
        if (!a) return;
        const ok = !!m.ok;
        if (s.phase === 'reveal' && a.ok !== ok && s.players[m.pid]) s.players[m.pid].score += ok ? 1 : -1;
        a.ok = ok;
        a.manual = true;
        return this.valider();
      }
      case 'reveal': {
        if (!['question', 'correction'].includes(s.phase) || !s.current) return;
        s.phase = 'reveal';
        const trouves = [];
        for (const [pid, a] of Object.entries(s.current.answers)) {
          if (a.ok && s.players[pid]) {
            s.players[pid].score += 1;
            trouves.push(pid);
          }
        }
        s.history.push({ animeId: s.current.animeId, found: trouves });
        return this.valider();
      }
      case 'next': {
        if (s.phase !== 'reveal') return;
        if (s.qIndex + 1 >= s.order.length) s.phase = 'end';
        else this.questionSuivante();
        return this.valider();
      }
      case 'finish': {
        if (['question', 'correction', 'reveal'].includes(s.phase)) {
          s.phase = 'end';
          s.current = null;
          return this.valider();
        }
        return;
      }
      case 'reset': {
        s.phase = 'lobby';
        s.current = null;
        s.order = [];
        s.qIndex = -1;
        s.history = [];
        s.battle = null;
        s.selection = [];
        s.picked = [];
        s.removed = [];
        for (const p of Object.values(s.players)) p.score = 0;
        return this.valider();
      }
      case 'addPlayer': {
        const name = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
        if (!name) return;
        if (Object.values(s.players).some((p) => normaliser(p.name) === normaliser(name))) {
          return this.envoyer(ws, { t: 'error', msg: 'Ce nom existe déjà.' });
        }
        const pid = crypto.randomUUID();
        s.players[pid] = { id: pid, name, score: 0, manual: true, connected: false, lastSeen: Date.now() };
        return this.valider();
      }
      case 'score': {
        const p = s.players[m.pid];
        if (!p) return;
        p.score += +m.delta === -1 ? -1 : 1;
        return this.valider();
      }
      case 'kick': {
        if (!s.players[m.pid]) return;
        for (const { ws: w, att: a } of this.sockets()) {
          if (a.role === 'player' && a.pid === m.pid) {
            this.envoyer(w, { t: 'kicked' });
            w.serializeAttachment({ role: 'player' });
          }
        }
        this.supprimerJoueur(m.pid);
        return this.valider();
      }
      case 'image': {
        if (!PAR_ID.has(m.id)) return;
        const url = String(m.url || '').trim();
        if (url && !/^https:\/\/\S+$/i.test(url)) return this.envoyer(ws, { t: 'error', msg: "L'adresse doit commencer par https://" });
        if (url) this.images[m.id] = url.slice(0, 500);
        else delete this.images[m.id];
        await this.ctx.storage.put('images', this.images);
        this.envoyer(ws, { t: 'toast', msg: url ? 'Image enregistrée.' : 'Image retirée.' });
        return this.diffuser();
      }
      case 'battle': {
        if (s.phase !== 'end') return;
        const tied = this.exAequo();
        if (tied.length < 2) return;
        const target = [1, 2, 3, 5].includes(+m.target) ? +m.target : 3;
        s.battle = { players: tied, target, points: Object.fromEntries(tied.map((p) => [p, 0])), round: 0, used: [], stage: 'question' };
        s.phase = 'battle';
        this.mancheSuivante();
        return this.valider();
      }
      case 'battleGive': {
        const b = s.battle;
        if (s.phase !== 'battle' || !b || b.roundWinner || b.stage === 'done' || !b.players.includes(m.pid)) return;
        this.gagneManche(m.pid);
        return this.valider();
      }
      case 'battleNext': {
        const b = s.battle;
        if (s.phase !== 'battle' || !b || b.stage === 'done') return;
        if (b.stage === 'question') b.stage = 'reveal';
        else this.mancheSuivante();
        return this.valider();
      }
      case 'battleStop': {
        if (s.phase !== 'battle') return;
        s.phase = 'end';
        s.battle = null;
        return this.valider();
      }
    }

    // --- Réservé à l'hôte principal ---
    if (att.role !== 'host') return;
    if (m.t === 'kickMaster' || m.t === 'blockMaster') {
      if (m.t === 'blockMaster') s.masterBlocked = !!m.blocked;
      if (m.t === 'kickMaster' || s.masterBlocked) {
        for (const { ws: w, att: a } of this.sockets()) {
          if (a.role === 'master') {
            this.envoyer(w, { t: 'kicked', msg: "L'hôte t'a déconnecté." });
            w.serializeAttachment({ role: 'anon' });
            try {
              w.close(4000, 'deconnecte');
            } catch (e) {}
          }
        }
      }
      await this.sauver();
      return this.diffuser();
    }
  }

  tirage() {
    const s = this.s;
    const garde = s.selection.filter((id) => s.picked.includes(id));
    const dispo = melanger(ANIMES.map((a) => a.id).filter((id) => !garde.includes(id) && !s.removed.includes(id)));
    s.selection = garde.concat(dispo.slice(0, Math.max(0, s.settings.count - garde.length)));
  }

  niveauPour(i) {
    const d = this.s.settings.difficulty;
    if (d === 'crescendo') return i < Math.ceil(this.s.order.length / 2) ? 'facile' : 'difficile';
    return d;
  }

  questionSuivante() {
    const s = this.s;
    s.qIndex += 1;
    const id = s.order[s.qIndex];
    s.current = {
      animeId: id,
      level: this.niveauPour(s.qIndex),
      deadline: s.settings.timer > 0 ? Date.now() + s.settings.timer * 1000 : null,
      answers: {},
    };
    s.phase = 'question';
  }

  exAequo() {
    const ps = Object.values(this.s.players);
    if (ps.length < 2) return [];
    const max = Math.max(...ps.map((p) => p.score));
    return ps.filter((p) => p.score === max).map((p) => p.id);
  }

  mancheSuivante() {
    const s = this.s;
    const b = s.battle;
    const utilises = new Set([...s.order, ...b.used]);
    let dispo = ANIMES.filter((a) => !utilises.has(a.id));
    if (!dispo.length) dispo = ANIMES.filter((a) => !b.used.includes(a.id));
    if (!dispo.length) dispo = ANIMES;
    const a = dispo[Math.floor(Math.random() * dispo.length)];
    b.used.push(a.id);
    b.round += 1;
    b.animeId = a.id;
    b.level = s.settings.difficulty === 'facile' ? 'facile' : 'difficile';
    b.attempts = {};
    b.roundWinner = null;
    b.stage = 'question';
  }

  gagneManche(pid) {
    const b = this.s.battle;
    b.roundWinner = pid;
    b.points[pid] = (b.points[pid] || 0) + 1;
    if (b.points[pid] >= b.target) {
      b.winner = pid;
      b.stage = 'done';
    } else b.stage = 'reveal';
  }

  async tentativeBataille(pid, texte) {
    const b = this.s.battle;
    if (!b || b.stage !== 'question' || !b.players.includes(pid) || b.attempts[pid]) return;
    const ok = estJuste(texte, PAR_ID.get(b.animeId));
    b.attempts[pid] = { text: texte, ok };
    if (ok) this.gagneManche(pid);
    else if (b.players.every((p) => b.attempts[p])) b.stage = 'reveal';
    return this.valider();
  }

  // ---------- Ce que chacun voit ----------

  vueCommune() {
    const s = this.s;
    const players = Object.values(s.players)
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        manual: p.manual,
        connected: p.connected,
        answered: !!(s.current && s.current.answers[p.id]),
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const v = {
      t: 'state',
      now: Date.now(),
      phase: s.phase,
      settings: s.settings,
      players,
      total: s.order.length || s.selection.length || s.settings.count,
      qIndex: s.qIndex,
      catalogueSize: ANIMES.length,
    };
    if (s.current && ['question', 'correction', 'reveal'].includes(s.phase)) {
      const a = PAR_ID.get(s.current.animeId);
      v.question = {
        level: s.current.level,
        text: s.current.level === 'difficile' ? a.hard : a.easy,
        deadline: s.current.deadline,
        answeredCount: Object.keys(s.current.answers).length,
      };
      if (s.phase === 'reveal') {
        v.reveal = {
          title: a.title,
          image: this.images[a.id] || null,
          found: Object.entries(s.current.answers)
            .filter(([pid, x]) => x.ok && s.players[pid])
            .map(([pid]) => s.players[pid].name),
        };
      }
    }
    if (s.phase === 'end') v.tied = this.exAequo().map((id) => s.players[id] && s.players[id].name);
    if (s.phase === 'battle' && s.battle) {
      const b = s.battle;
      const a = PAR_ID.get(b.animeId);
      v.battle = {
        round: b.round,
        target: b.target,
        stage: b.stage,
        level: b.level,
        text: a ? (b.level === 'difficile' ? a.hard : a.easy) : '',
        players: b.players.map((id) => ({
          id,
          name: s.players[id] ? s.players[id].name : '?',
          points: b.points[id] || 0,
          tried: !!b.attempts[id],
          ok: b.stage !== 'question' && b.attempts[id] ? b.attempts[id].ok : undefined,
          text: b.stage !== 'question' && b.attempts[id] ? b.attempts[id].text : undefined,
        })),
        roundWinner: b.roundWinner && s.players[b.roundWinner] ? s.players[b.roundWinner].name : null,
        winner: b.winner && s.players[b.winner] ? s.players[b.winner].name : null,
      };
      if (b.stage !== 'question' && a) {
        v.battle.title = a.title;
        v.battle.image = this.images[a.id] || null;
      }
    }
    return v;
  }

  vueAdmin(base, role, masterConnecte) {
    const s = this.s;
    const v = { ...base, role };
    v.masterBlocked = s.masterBlocked;
    v.masterConnected = masterConnecte;
    v.selection = s.selection.map((id) => ({ id, title: PAR_ID.get(id).title, picked: s.picked.includes(id), image: this.images[id] || null }));
    v.removedCount = s.removed.length;
    if (s.current && ['question', 'correction', 'reveal'].includes(s.phase)) {
      const a = PAR_ID.get(s.current.animeId);
      v.answer = { id: a.id, title: a.title, keys: a.keys, image: this.images[a.id] || null, other: s.current.level === 'difficile' ? a.easy : a.hard };
      v.answers = Object.entries(s.current.answers).map(([pid, x]) => ({
        pid,
        name: s.players[pid] ? s.players[pid].name : '?',
        text: x.text,
        ok: x.ok,
        manual: x.manual,
      }));
    }
    if (s.phase === 'battle' && s.battle) {
      const b = s.battle;
      const a = PAR_ID.get(b.animeId);
      v.battleAdmin = {
        id: a.id,
        title: a.title,
        keys: a.keys,
        attempts: Object.entries(b.attempts).map(([pid, x]) => ({ pid, name: s.players[pid] ? s.players[pid].name : '?', text: x.text, ok: x.ok })),
      };
    }
    return v;
  }

  vueJoueur(base, pid) {
    const s = this.s;
    const v = { ...base, role: 'player' };
    const p = pid && s.players[pid];
    if (!p) {
      v.me = null;
      return v;
    }
    v.me = { pid, name: p.name, score: p.score };
    if (s.current && ['question', 'correction', 'reveal'].includes(s.phase)) {
      const a = s.current.answers[pid];
      v.me.answer = a ? a.text : null;
      if (s.phase === 'reveal') v.me.ok = !!(a && a.ok);
    }
    if (s.phase === 'battle' && s.battle) {
      const b = s.battle;
      v.me.inBattle = b.players.includes(pid);
      v.me.battleAttempt = b.attempts[pid] ? b.attempts[pid].text : null;
    }
    return v;
  }

  envoyerVue(ws) {
    this.diffuser(null, ws);
  }

  diffuser(exclure, seulement) {
    const base = this.vueCommune();
    const tous = this.sockets().filter((x) => x.ws !== exclure);
    const masterConnecte = tous.some((x) => x.att.role === 'master');
    const cibles = seulement ? tous.filter((x) => x.ws === seulement) : tous;
    let vueEcran = null;
    for (const { ws, att } of cibles) {
      let v;
      if (att.role === 'host' || att.role === 'master') v = this.vueAdmin(base, att.role, masterConnecte);
      else if (att.role === 'player') v = this.vueJoueur(base, att.pid);
      else if (att.role === 'screen') v = vueEcran || (vueEcran = { ...base, role: 'screen' });
      else continue;
      this.envoyer(ws, v);
    }
  }
}

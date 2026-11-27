// Quiz « Devine l'animé » : pages joueur, hôte (#hote), master (#master) et écran (#ecran)
(() => {
  const app = document.getElementById('app');
  const statusEl = document.getElementById('status');
  const toastEl = document.getElementById('toast');

  const hash = location.hash.replace('#', '').toLowerCase();
  const ROLE = hash === 'hote' || hash === 'host' ? 'host' : hash === 'master' ? 'master' : hash === 'ecran' ? 'screen' : 'player';
  if (ROLE === 'screen') document.body.classList.add('screen');
  window.addEventListener('hashchange', () => location.reload());

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const CODE_KEY = ROLE === 'host' ? 'qa_code_hote' : 'qa_code_master';

  let ws = null;
  let S = null; // dernier état reçu
  let offset = 0; // décalage d'horloge avec le serveur
  let authed = false;
  let authError = '';
  let joinError = '';
  let searchRes = null;
  let imageEdit = null; // id de l'animé dont on modifie l'image (salon)
  let retry = 0;
  let pingTimer = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (toastEl.hidden = true), 3500);
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      statusEl.textContent = 'Connecté';
      statusEl.className = 'status ok';
      if (ROLE === 'player') send({ t: 'hello', role: 'player', pid: store.get('qa_pid') });
      else if (ROLE === 'screen') send({ t: 'hello', role: 'screen' });
      else {
        const code = store.get(CODE_KEY);
        if (code) send({ t: 'auth', role: ROLE, code });
        else render();
      }
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 25000);
    };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') return;
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onMessage(m);
    };
    ws.onclose = () => {
      statusEl.textContent = 'Reconnexion…';
      statusEl.className = 'status ko';
      clearInterval(pingTimer);
      retry++;
      setTimeout(connect, Math.min(8000, 500 * retry));
    };
  }

  function onMessage(m) {
    switch (m.t) {
      case 'state':
        offset = m.now - Date.now();
        S = m;
        if (ROLE === 'player' && !m.me && store.get('qa_pid')) store.del('qa_pid');
        if ((ROLE === 'host' || ROLE === 'master') && m.role === ROLE) authed = true;
        render();
        break;
      case 'joined':
        store.set('qa_pid', m.pid);
        joinError = '';
        break;
      case 'auth':
        if (m.ok) { authed = true; authError = ''; }
        else { authed = false; authError = m.msg || 'Code incorrect.'; store.del(CODE_KEY); render(); }
        break;
      case 'kicked':
        if (ROLE === 'player') { store.del('qa_pid'); toast("Tu as été retiré de la partie."); }
        else { authed = false; authError = m.msg || 'Déconnecté.'; store.del(CODE_KEY); render(); }
        break;
      case 'search':
        searchRes = m;
        render();
        break;
      case 'toast':
        toast(m.msg);
        break;
      case 'error':
        if (ROLE === 'player' && !(S && S.me)) { joinError = m.msg; render(); }
        else toast(m.msg);
        break;
    }
  }

  // ---------- Rendu (en gardant ce que l'utilisateur est en train de taper) ----------

  function render() {
    const keep = {};
    app.querySelectorAll('input[id], select[id]').forEach((el) => (keep[el.id] = el.value));
    const active = document.activeElement && document.activeElement.id;
    let sel = null;
    if (active && document.activeElement.selectionStart != null) sel = [document.activeElement.selectionStart, document.activeElement.selectionEnd];

    let html;
    if (ROLE === 'player') html = vuePlayer();
    else if (ROLE === 'screen') html = vueScreen();
    else html = vueAdmin();
    app.innerHTML = html;

    for (const [id, v] of Object.entries(keep)) {
      const el = document.getElementById(id);
      if (el && el.tagName === 'INPUT' && (el.dataset.keep !== 'no' || id === active)) el.value = v;
    }
    if (active) {
      const el = document.getElementById(active);
      if (el) {
        el.focus();
        if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) {}
      }
    }
    tick();
  }

  function tick() {
    document.querySelectorAll('[data-deadline]').forEach((el) => {
      const left = Math.max(0, Math.ceil((+el.dataset.deadline - (Date.now() + offset)) / 1000));
      el.textContent = left + ' s';
      el.classList.toggle('low', left <= 5);
    });
  }
  setInterval(tick, 250);

  const niveauTag = (lvl) => `<span class="tag ${lvl}">${lvl === 'difficile' ? 'Difficile' : 'Facile'}</span>`;
  const timerHtml = (q) => (q && q.deadline ? `<span class="timer" data-deadline="${q.deadline}"></span>` : '');
  const numHtml = () => `<span class="muted">Animé ${S.qIndex + 1} / ${S.total}</span>`;

  function classement(players, highlight) {
    let rang = 0, prev = null;
    return `<ol class="podium">${players.map((p, i) => {
      if (p.score !== prev) { rang = i + 1; prev = p.score; }
      return `<li class="${rang === 1 ? 'first' : ''}"><span class="rk">${rang === 1 ? '🏆' : rang + 'e'}</span><span class="name">${esc(p.name)}${highlight === p.id ? ' (toi)' : ''}</span><span class="score">${p.score} pt${p.score > 1 ? 's' : ''}</span></li>`;
    }).join('')}</ol>`;
  }

  function chipsJoueurs(players) {
    return `<div class="chips">${players.map((p) => `<span class="chip ${p.connected || p.manual ? '' : 'off'}">${esc(p.name)}</span>`).join('') || '<span class="muted">Personne pour l\'instant.</span>'}</div>`;
  }

  function revealBlock(r) {
    return `<div class="reveal-title">${esc(r.title)}</div>
      ${r.image ? `<img class="reveal-img" src="${esc(r.image)}" alt="" referrerpolicy="no-referrer">` : ''}
      <p>${r.found.length ? `Trouvé par : <strong>${r.found.map(esc).join(', ')}</strong>` : 'Personne n\'a trouvé !'}</p>`;
  }

  // ---------- Joueur ----------

  function vuePlayer() {
    if (!S) return `<div class="card">Chargement…</div>`;
    const me = S.me;
    if (!me) {
      return `<div class="card">
        <h2>Rejoindre la partie</h2>
        <p class="muted">Choisis un pseudo. Pas besoin de compte.</p>
        <form class="answer-form" onsubmit="event.preventDefault(); QA.join()">
          <input id="pseudo" maxlength="20" placeholder="Ton pseudo" autocomplete="off">
          <button class="main">Entrer</button>
        </form>
        ${joinError ? `<p class="ko">${esc(joinError)}</p>` : ''}
      </div>`;
    }
    let body = '';
    const quitter = `<div class="row" style="justify-content:flex-end"><button class="ghost mini" onclick="QA.leave()">Quitter la partie</button></div>`;
    switch (S.phase) {
      case 'lobby':
        body = `<div class="card"><h2>Salut ${esc(me.name)} 👋</h2><p>La partie va bientôt commencer. Garde cette page ouverte.</p>
          <h3>Joueurs</h3>${chipsJoueurs(S.players)}</div>`;
        break;
      case 'question':
        body = `<div class="card"><div class="row" style="justify-content:space-between">${numHtml()} ${niveauTag(S.question.level)} ${timerHtml(S.question)}</div>
          <p class="desc">${esc(S.question.text)}</p>
          <form class="answer-form" onsubmit="event.preventDefault(); QA.answer()">
            <input id="rep" maxlength="80" placeholder="Le nom de l'animé…" autocomplete="off">
            <button class="main">Valider</button>
          </form>
          <p class="muted small">${me.answer ? `Ta réponse : <strong>${esc(me.answer)}</strong> (tu peux la changer jusqu'à la fin)` : 'Tu peux modifier ta réponse tant que le temps n\'est pas écoulé.'}</p>
        </div>`;
        break;
      case 'correction':
        body = `<div class="card"><div class="row" style="justify-content:space-between">${numHtml()} ${niveauTag(S.question.level)}</div>
          <p class="desc">${esc(S.question.text)}</p>
          <p>⏳ Réponses fermées, l'hôte corrige…</p>
          <p class="muted">Ta réponse : <strong>${me.answer ? esc(me.answer) : '(aucune)'}</strong></p></div>`;
        break;
      case 'reveal':
        body = `<div class="card center">${numHtml()}
          ${revealBlock(S.reveal)}
          <p class="big ${me.ok ? 'ok' : 'ko'}">${me.ok ? '✅ Bien joué, +1 point !' : me.answer ? `❌ Raté (« ${esc(me.answer)} »)` : '❌ Pas de réponse'}</p>
          <p class="muted">Ton score : ${me.score}</p></div>
          <div class="card"><h3>Classement</h3>${classement(S.players, me.pid)}</div>`;
        break;
      case 'end':
        body = `<div class="card"><h2>Fin de la partie 🎉</h2>${classement(S.players, me.pid)}
          ${S.tied && S.tied.length > 1 ? `<p class="muted">Égalité en tête ! L'hôte peut lancer une bataille finale.</p>` : ''}</div>`;
        break;
      case 'battle':
        body = vueBataille(true);
        break;
    }
    return body + quitter;
  }

  function vueBataille(isPlayer, admin) {
    const b = S.battle;
    if (!b) return '';
    const me = S.me;
    let html = `<div class="card"><h2>⚔️ Bataille finale <span class="muted small">— manche ${b.round}, premier à ${b.target} point${b.target > 1 ? 's' : ''}</span></h2>
      <div class="chips">${b.players.map((p) => `<span class="chip">${esc(p.name)} : <strong>${p.points}</strong>${b.stage === 'question' && p.tried ? ' ✋' : ''}</span>`).join('')}</div>`;
    if (b.stage === 'done') {
      html += `<p class="reveal-title center">🏆 ${b.winner ? esc(b.winner) + ' gagne la bataille !' : 'Bataille terminée'}</p>`;
      if (b.title) html += `<p class="center muted">Dernier animé : ${esc(b.title)}</p>`;
      return html + '</div>';
    }
    html += `<div class="row" style="margin-top:8px">${niveauTag(b.level)}</div><p class="desc">${esc(b.text)}</p>`;
    if (b.stage === 'question') {
      if (isPlayer && me && me.inBattle) {
        if (me.battleAttempt) html += `<p>Ta tentative : <strong>${esc(me.battleAttempt)}</strong>. Attends les autres…</p>`;
        else html += `<p class="muted small">Une seule tentative ! Le premier qui trouve marque le point.</p>
          <form class="answer-form" onsubmit="event.preventDefault(); QA.answer()">
          <input id="rep" maxlength="80" placeholder="Le nom de l'animé…" autocomplete="off"><button class="main">Tenter</button></form>`;
      } else if (isPlayer) html += `<p class="muted">Tu regardes la bataille entre les ex æquo.</p>`;
    } else {
      html += `<div class="center"><div class="reveal-title">${esc(b.title)}</div>
        ${b.image ? `<img class="reveal-img" src="${esc(b.image)}" alt="" referrerpolicy="no-referrer" style="margin:auto">` : ''}
        <p class="bigline">${b.roundWinner ? `Point pour <strong>${esc(b.roundWinner)}</strong> !` : 'Personne ne marque cette manche.'}</p></div>`;
      const essais = b.players.filter((p) => p.text);
      if (essais.length) html += `<p class="muted small">${essais.map((p) => `${esc(p.name)} : « ${esc(p.text)} » ${p.ok ? '✅' : '❌'}`).join(' · ')}</p>`;
    }
    return html + '</div>';
  }

  // ---------- Écran Discord ----------

  function vueScreen() {
    if (!S) return `<div class="card">Chargement…</div>`;
    const lien = location.origin + '/';
    switch (S.phase) {
      case 'lobby':
        return `<div class="card center"><h1 class="big">🎬 Devine l'animé</h1>
          <p class="bigline">Rejoins la partie sur <strong>${esc(lien)}</strong></p>
          <p class="muted">${S.settings.difficulty === 'crescendo' ? 'Mode Crescendo' : S.settings.difficulty === 'difficile' ? 'Mode Difficile' : 'Mode Facile'} · ${S.total} animés</p></div>
          <div class="card"><h2>Joueurs (${S.players.length})</h2>${chipsJoueurs(S.players)}</div>`;
      case 'question':
        return `<div class="card"><div class="row" style="justify-content:space-between">${numHtml()} ${niveauTag(S.question.level)} ${timerHtml(S.question)}</div>
          <p class="desc">${esc(S.question.text)}</p>
          <p class="muted bigline">${S.question.answeredCount} / ${S.players.filter((p) => !p.manual).length} ont répondu</p></div>`;
      case 'correction':
        return `<div class="card"><div class="row" style="justify-content:space-between">${numHtml()} ${niveauTag(S.question.level)}</div>
          <p class="desc">${esc(S.question.text)}</p><p class="bigline">⏳ Temps écoulé ! Correction en cours…</p></div>`;
      case 'reveal':
        return `<div class="card center">${numHtml()}${revealBlock(S.reveal)}</div>
          <div class="card"><h2>Classement</h2>${classement(S.players.slice(0, 10))}</div>`;
      case 'end':
        return `<div class="card"><h1 class="center">🏁 Classement final</h1>${classement(S.players)}</div>`;
      case 'battle':
        return vueBataille(false);
    }
    return '';
  }

  // ---------- Hôte et master ----------

  function vueAdmin() {
    const nom = ROLE === 'host' ? 'Hôte' : 'Master';
    if (!authed) {
      return `<div class="card"><h2>Accès ${nom}</h2>
        <form class="answer-form" onsubmit="event.preventDefault(); QA.auth()">
          <input id="code" type="password" placeholder="${ROLE === 'host' ? 'Code hôte' : 'Mot de passe master'}" autocomplete="off">
          <button class="main">Entrer</button>
        </form>${authError ? `<p class="ko">${esc(authError)}</p>` : ''}</div>`;
    }
    if (!S) return `<div class="card">Chargement…</div>`;
    let centre = '';
    switch (S.phase) {
      case 'lobby': centre = adminLobby(); break;
      case 'question':
      case 'correction':
      case 'reveal': centre = adminQuestion(); break;
      case 'end': centre = adminEnd(); break;
      case 'battle': centre = adminBattle(); break;
    }
    const masterBox = ROLE === 'host'
      ? `<div class="card sub small"><strong>Master</strong> : ${S.masterConnected ? '<span class="ok">connecté</span>' : '<span class="muted">non connecté</span>'}${S.masterBlocked ? ' · <span class="ko">accès bloqué</span>' : ''}
        <div class="row" style="margin-top:6px">
          ${S.masterConnected ? `<button class="mini kob" onclick="QA.send({t:'kickMaster'})">Déconnecter le master</button>` : ''}
          ${S.masterBlocked ? `<button class="mini" onclick="QA.send({t:'blockMaster',blocked:false})">Rouvrir l'accès</button>` : `<button class="mini ghost" onclick="QA.send({t:'blockMaster',blocked:true})">Bloquer l'accès</button>`}
        </div></div>`
      : `<div class="card sub small">Tu animes en tant que <strong>master</strong>.</div>`;
    return `<div class="grid2 admin-grid">
      <div>${centre}</div>
      <div>${adminJoueurs()}${adminReglagesLive()}${masterBox}
        <div class="row"><button class="ghost mini" onclick="QA.logout()">Se déconnecter</button></div></div>
    </div>`;
  }

  function adminJoueurs() {
    const enQuestion = S.phase === 'question' || S.phase === 'correction';
    return `<div class="card"><h3>Joueurs (${S.players.length})</h3>
      <ul class="players">${S.players.map((p) => `<li>
        <span class="dot ${p.manual ? 'man' : p.connected ? 'on' : ''}" title="${p.manual ? 'Ajouté à la main' : p.connected ? 'Connecté' : 'Déconnecté'}"></span>
        <span class="name">${esc(p.name)}${enQuestion && p.answered ? ' ✋' : ''}</span>
        <span class="score">${p.score}</span>
        <button class="mini ghost" title="Retirer 1 point" onclick="QA.send({t:'score',pid:'${p.id}',delta:-1})">−</button>
        <button class="mini ghost" title="Ajouter 1 point" onclick="QA.send({t:'score',pid:'${p.id}',delta:1})">+</button>
        <button class="mini kob" title="Retirer de la partie" onclick="QA.kick('${p.id}', '${esc(p.name).replace(/'/g, "\\'")}')">✕</button>
      </li>`).join('') || '<li class="muted">Personne pour l\'instant.</li>'}</ul>
      <form class="answer-form" style="margin-top:8px" onsubmit="event.preventDefault(); QA.addPlayer()">
        <input id="addname" maxlength="20" placeholder="Ajouter un candidat à la main">
        <button class="mini">Ajouter</button>
      </form>
      <p class="muted small">● vert : connecté · ● jaune : ajouté à la main (jamais retiré automatiquement).</p></div>`;
  }

  function adminReglagesLive() {
    const st = S.settings;
    const opt = (vals, cur) => vals.map(([v, l]) => `<option value="${v}" ${+cur === v ? 'selected' : ''}>${l}</option>`).join('');
    return `<div class="card small"><h3>Réglages</h3>
      <label>Temps par animé<br><select onchange="QA.send({t:'settings',timer:this.value})">${opt([[20, '20 s'], [30, '30 s'], [45, '45 s'], [60, '60 s'], [90, '90 s'], [0, 'Sans limite']], st.timer)}</select></label><br><br>
      <label>Retirer un joueur déconnecté après<br><select onchange="QA.send({t:'settings',timeout:this.value})">${opt([[1, '1 minute'], [2, '2 minutes'], [5, '5 minutes'], [0, 'Jamais']], st.timeout)}</select></label>
    </div>`;
  }

  function adminLobby() {
    const st = S.settings;
    const opt = (vals, cur) => vals.map(([v, l]) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${l}</option>`).join('');
    const res = searchRes && searchRes.results;
    return `<div class="card"><h2>Préparer la partie</h2>
      <div class="row">
        <label>Difficulté<br><select onchange="QA.send({t:'settings',difficulty:this.value})">${opt([['facile', 'Facile'], ['difficile', 'Difficile'], ['crescendo', 'Crescendo']], st.difficulty)}</select></label>
        <label>Nombre d'animés<br><select onchange="QA.send({t:'settings',count:this.value})">${opt([[5, 5], [10, 10], [15, 15], [20, 20], [30, 30]], st.count)}</select></label>
      </div>
      <p class="muted small">Facile : indices connus. Difficile : un détail précis de l'histoire. Crescendo : la première moitié en facile, la seconde en difficile.</p>
      <div class="row"><button class="main" onclick="QA.send({t:'start'})">▶ Lancer la partie</button></div>
    </div>
    <div class="card"><h3>Choisir un animé</h3>
      <form class="answer-form" onsubmit="event.preventDefault(); QA.search()">
        <input id="q" placeholder="Tape un titre, même mal orthographié (ex. « snk », « demon slayr »)" autocomplete="off">
        <button>Chercher</button>
      </form>
      ${res ? (res.length ? `<ul class="sel" style="margin-top:8px">${res.map((r) => `<li><span class="t">${esc(r.title)} ${r.inGame ? '<span class="ok small">déjà dans la partie</span>' : r.removed ? '<span class="muted small">retiré</span>' : ''}</span>
        ${r.inGame ? '' : `<button class="mini" onclick="QA.send({t:'pick',id:'${r.id}'})">Ajouter</button>`}</li>`).join('')}</ul>` : `<p class="ko">Aucun animé du catalogue ne correspond à « ${esc(searchRes.q)} ».</p>`) : ''}
    </div>
    <div class="card"><div class="row" style="justify-content:space-between"><h3>Animés de la partie (${S.selection.length})</h3>
      <button class="mini" onclick="QA.send({t:'draw'})">🎲 Tirer au sort</button></div>
      <p class="muted small">Le tirage complète la liste jusqu'au nombre choisi, en gardant ceux que tu as ajoutés à la main. Si la liste est vide au lancement, le tirage se fait tout seul. Catalogue : ${S.catalogueSize} animés.${S.removedCount ? ` ${S.removedCount} retiré(s) pour cette partie.` : ''}</p>
      <ul class="sel">${S.selection.map((a) => `<li><span class="t">${a.picked ? '📌 ' : ''}${esc(a.title)}${a.image ? ' 🖼️' : ''}</span>
        <button class="mini ghost" onclick="QA.imageEdit('${a.id}')">Image</button>
        <button class="mini kob" onclick="QA.send({t:'unpick',id:'${a.id}'})">Enlever</button></li>
        ${imageEdit === a.id ? `<li><form class="answer-form" style="width:100%" onsubmit="event.preventDefault(); QA.saveImage('${a.id}','img-${a.id}')">
          <input id="img-${a.id}" placeholder="https://… (vide pour retirer)" value="${esc(a.image || '')}" data-keep="no"><button class="mini">OK</button></form></li>` : ''}`).join('')}</ul>
    </div>`;
  }

  function adminQuestion() {
    const q = S.question;
    const a = S.answer;
    const phaseTxt = S.phase === 'question' ? 'Réponses ouvertes' : S.phase === 'correction' ? 'Correction' : 'Réponse révélée';
    const derniere = S.qIndex + 1 >= S.total;
    let actions = '';
    if (S.phase === 'question') actions = `<button onclick="QA.send({t:'close'})">⏹ Fermer les réponses</button><button class="main" onclick="QA.send({t:'reveal'})">Révéler</button>`;
    else if (S.phase === 'correction') actions = `<button class="main" onclick="QA.send({t:'reveal'})">Révéler la réponse</button>`;
    else actions = `<button class="main" onclick="QA.send({t:'next'})">${derniere ? '🏁 Voir le classement final' : 'Animé suivant ▶'}</button>`;
    const reps = (S.answers || []).slice().sort((x, y) => x.name.localeCompare(y.name));
    return `<div class="card"><div class="row" style="justify-content:space-between">${numHtml()} ${niveauTag(q.level)} <strong>${phaseTxt}</strong> ${S.phase === 'question' ? timerHtml(q) : ''}</div>
      <p class="desc">${esc(q.text)}</p>
      <p>Réponse : <strong class="ok">${esc(a.title)}</strong> <span class="muted small">(acceptées aussi : ${a.keys.map(esc).join(', ')})</span></p>
      <p class="muted small">Autre description : ${esc(a.other)}</p>
      <div class="row">${actions}</div></div>
    <div class="card"><h3>Réponses (${reps.length})</h3>
      <p class="muted small">Corrigées automatiquement. Clique sur ✅ ou ❌ pour changer une correction (par exemple pour une faute).</p>
      <ul class="answers">${reps.map((r) => `<li><span class="txt"><strong>${esc(r.name)}</strong> : ${esc(r.text)} ${r.manual ? '<span class="muted small">(corrigé à la main)</span>' : ''}</span>
        <button class="mini ${r.ok ? 'okb' : 'ghost'}" onclick="QA.send({t:'judge',pid:'${r.pid}',ok:true})">✅</button>
        <button class="mini ${!r.ok ? 'kob' : 'ghost'}" onclick="QA.send({t:'judge',pid:'${r.pid}',ok:false})">❌</button></li>`).join('') || '<li class="muted">Aucune réponse pour l\'instant.</li>'}</ul></div>
    <div class="card small"><h3>Image de l'animé</h3>
      <form class="answer-form" onsubmit="event.preventDefault(); QA.saveImage('${a.id}','imgq')">
        <input id="imgq" placeholder="https://… (adresse d'une image)" value="${esc(a.image || '')}" data-keep="no"><button class="mini">Enregistrer</button></form>
      <p class="muted">Clic droit sur une image (AniList, MyAnimeList…), puis « Copier l'adresse de l'image ». Elle s'affichera à la révélation, et restera pour les prochaines parties.</p>
      ${a.image ? `<img class="reveal-img" src="${esc(a.image)}" alt="" referrerpolicy="no-referrer" style="max-height:140px">` : ''}</div>
    <div class="row"><button class="ghost mini" onclick="QA.confirm('Terminer la partie maintenant ?', {t:'finish'})">Terminer la partie</button></div>`;
  }

  function adminEnd() {
    const tied = S.tied || [];
    return `<div class="card"><h2>🏁 Classement final</h2>${classement(S.players)}</div>
      ${tied.length > 1 ? `<div class="card"><h3>⚔️ Égalité : ${tied.map(esc).join(', ')}</h3>
        <p class="muted small">Lance une bataille finale entre les ex æquo. Chaque manche, un nouvel animé est tiré au sort (${S.settings.difficulty === 'facile' ? 'en facile' : 'en difficile'}). Une seule tentative par joueur, le premier qui trouve marque.</p>
        <div class="row">Score à atteindre : ${[1, 2, 3, 5].map((n) => `<button onclick="QA.send({t:'battle',target:${n}})">${n} point${n > 1 ? 's' : ''}</button>`).join('')}</div></div>` : ''}
      <div class="row"><button class="main" onclick="QA.confirm('Revenir au salon ? Les scores seront remis à zéro.', {t:'reset'})">🔁 Nouvelle partie</button></div>`;
  }

  function adminBattle() {
    const b = S.battle;
    const ba = S.battleAdmin;
    let html = vueBataille(false, true);
    if (b.stage === 'done') {
      return html + `<div class="row"><button onclick="QA.send({t:'battleStop'})">Retour au classement</button>
        <button class="main" onclick="QA.confirm('Revenir au salon ? Les scores seront remis à zéro.', {t:'reset'})">🔁 Nouvelle partie</button></div>`;
    }
    html += `<div class="card"><p>Réponse : <strong class="ok">${esc(ba.title)}</strong> <span class="muted small">(${ba.keys.map(esc).join(', ')})</span></p>
      <h3>Tentatives</h3><ul class="answers">${ba.attempts.map((x) => `<li><span class="txt"><strong>${esc(x.name)}</strong> : ${esc(x.text)}</span> ${x.ok ? '✅' : '❌'}</li>`).join('') || '<li class="muted">Aucune pour l\'instant.</li>'}</ul>
      ${!b.roundWinner ? `<p class="muted small">Donner la manche à la main (par exemple si une réponse contient une faute) :</p>
        <div class="row">${b.players.map((p) => `<button class="mini" onclick="QA.send({t:'battleGive',pid:'${p.id}'})">Donner à ${esc(p.name)}</button>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:10px">${b.stage === 'question' ? `<button onclick="QA.send({t:'battleNext'})">Révéler sans gagnant</button>` : `<button class="main" onclick="QA.send({t:'battleNext'})">Manche suivante ▶</button>`}
        <button class="ghost mini" onclick="QA.confirm('Arrêter la bataille ?', {t:'battleStop'})">Arrêter la bataille</button></div></div>`;
    return html;
  }

  // ---------- Actions ----------

  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const clear = (id) => { const el = document.getElementById(id); if (el) el.value = ''; };

  window.QA = {
    send,
    join() { const n = val('pseudo'); if (n) send({ t: 'join', name: n }); },
    answer() { const r = val('rep'); if (!r) return; send({ t: 'answer', text: r }); clear('rep'); },
    leave() { if (!confirm('Quitter la partie ? Tu perdras tes points.')) return; send({ t: 'leave' }); store.del('qa_pid'); },
    auth() { const c = val('code'); if (!c) return; store.set(CODE_KEY, c); send({ t: 'auth', role: ROLE, code: c }); },
    logout() { store.del(CODE_KEY); authed = false; authError = ''; try { ws.close(); } catch (e) {} render(); },
    addPlayer() { const n = val('addname'); if (!n) return; send({ t: 'addPlayer', name: n }); clear('addname'); },
    kick(pid, name) { if (confirm(`Retirer ${name} de la partie ?`)) send({ t: 'kick', pid }); },
    search() { const q = val('q'); if (q) send({ t: 'search', q }); },
    imageEdit(id) { imageEdit = imageEdit === id ? null : id; render(); },
    saveImage(id, inputId) { send({ t: 'image', id, url: val(inputId) }); imageEdit = null; },
    confirm(msg, o) { if (confirm(msg)) send(o); },
  };

  render();
  connect();
})();

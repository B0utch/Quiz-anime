# Devine l'animé, sur Cloudflare

Le principe : une petite description humoristique s'affiche, et les joueurs doivent trouver le nom de l'animé.

Le site tourne sur Cloudflare Workers, sur le forfait gratuit, exactement comme le Quiz des Mythiques. Il se compose de la page du quiz et d'un petit serveur (un Durable Object) qui garde la partie et l'envoie en direct à tous les joueurs.

Les joueurs n'ont besoin d'aucun compte : ils ouvrent simplement le lien. Les réponses restent sur le serveur, et seules les pages de l'hôte et du master, protégées par un code, peuvent les voir.

## Mise en ligne (une seule fois)

1. Installe **Node.js** (version LTS) depuis https://nodejs.org, si ce n'est pas déjà fait.
2. Dézippe ce dossier. Fais un clic droit dans le dossier, puis choisis « Ouvrir dans le terminal ».
3. Installe l'outil Cloudflare :
   ```
   npm install
   ```
4. Connecte-toi à ton compte Cloudflare. Une page s'ouvre dans ton navigateur : clique sur « Allow ».
   ```
   npx wrangler login
   ```
5. Mets le site en ligne :
   ```
   npx wrangler deploy
   ```
   À la fin, la commande affiche l'adresse du site, par exemple `https://quiz-anime.ton-pseudo.workers.dev`. Ce site est séparé du Quiz des Mythiques : les deux peuvent tourner en même temps.
6. Ouvre l'adresse du site suivie de `#hote` et tape le code hôte `314159`.

## Les liens

| Pour qui | Lien |
|---|---|
| Joueurs | `https://quiz-anime.ton-pseudo.workers.dev/` |
| Toi, l'hôte (avec ton code) | `https://quiz-anime.ton-pseudo.workers.dev/#hote` |
| Écran à partager sur Discord | `https://quiz-anime.ton-pseudo.workers.dev/#ecran` |
| Master (mot de passe `lustalia`) | `https://quiz-anime.ton-pseudo.workers.dev/#master` |

Le lien de l'hôte n'est protégé que par le code : ne donne ce code à personne. Pour changer le code hôte ou le mot de passe master, modifie les deux lignes `CODE_HOTE` et `MOT_DE_PASSE_MASTER` en haut de `src/worker.js`, puis relance `npx wrangler deploy`.

## Déroulement d'une partie

1. **Salon :** les joueurs ouvrent le lien et choisissent un pseudo. Toi, tu choisis la difficulté et le nombre d'animés (5, 10, 15, 20 ou 30), puis tu cliques sur « Lancer la partie ».
2. **Question :** la description s'affiche chez tout le monde. Chaque joueur tape le nom de l'animé. Il peut changer sa réponse tant que le temps n'est pas écoulé.
3. **Correction :** quand le temps est écoulé (ou quand tu cliques sur « Fermer les réponses »), tu vois toutes les réponses, déjà corrigées automatiquement. Tu peux changer une correction avec ✅ ou ❌, par exemple pour une faute.
4. **Révélation :** le titre s'affiche, avec son image si tu en as mis une, et chaque bonne réponse rapporte 1 point.
5. **Fin :** le classement final s'affiche. En cas d'égalité en tête, tu peux lancer une bataille finale.

Le temps par animé (20 s à 90 s, ou sans limite) se règle à tout moment dans « Réglages ».

## Difficulté

Avant la partie, l'hôte choisit la difficulté :

- **Facile :** des indices connus, avec un ton léger.
- **Difficile :** un détail précis de l'histoire, toujours avec humour.
- **Crescendo :** la première moitié des animés en facile, la seconde en difficile.

Pendant la partie, la page hôte affiche aussi l'autre description (facile ou difficile), pour t'aider à donner un indice si personne ne trouve.

## Réponses acceptées

Les majuscules, les accents et la ponctuation ne comptent pas. Les titres alternatifs et les abréviations sont acceptés (« snk » ou « Shingeki no Kyojin » pour L'Attaque des Titans, « dbz » pour Dragon Ball), et une petite faute de frappe passe sur les titres assez longs (« one pice », « fullmetal alchimist »). Si une réponse est refusée à tort, corrige-la à la main avec ✅.

## Modifier ou ajouter des animés

Le catalogue (111 animés) se trouve dans `src/questions.js`. Pour chaque animé :

- `title` : le titre affiché à la révélation (il est toujours accepté comme réponse) ;
- `keys` : les autres réponses acceptées, sans accents et en minuscules ;
- `easy` : la description en mode Facile ;
- `hard` : la description en mode Difficile.

Pour ajouter un animé, copie un bloc existant, donne-lui un `id` nouveau, puis relance :
```
npx wrangler deploy
```

## Choisir un animé précis

Avant la partie, la section « Choisir un animé » de la page hôte permet d'ajouter un animé précis à la partie.

- Tape un titre, même mal orthographié ou abrégé : le site trouve le bon (« demon slayr » donne Demon Slayer, « snk » donne L'Attaque des Titans).
- Le site indique si l'animé est déjà dans la partie, et le remet automatiquement s'il avait été retiré.
- Un titre qui ne correspond à aucun animé du catalogue est refusé.
- « Tirer au sort » complète la liste au hasard jusqu'au nombre choisi, en gardant ceux ajoutés à la main (marqués 📌).
- « Enlever » sort un animé de cette partie seulement.

## Images

Quand tu révèles une réponse, l'image de l'animé s'affiche, si tu en as enregistré une. Pour ajouter une image, depuis la page hôte :

- **Avant la partie :** clique sur « Image » à côté d'un animé de la liste.
- **Pendant la partie :** utilise le champ « Image de l'animé ».

Colle l'adresse de l'image : sur AniList ou MyAnimeList, fais un clic droit sur l'affiche, puis « Copier l'adresse de l'image ». L'adresse doit commencer par `https://`. Les images restent enregistrées pour les parties suivantes.

## Bataille finale

En cas d'égalité à la fin du quiz, l'hôte lance une bataille finale entre les ex æquo et choisit le score à atteindre (1, 2, 3 ou 5 points). À chaque manche, un nouvel animé est tiré au sort. Chaque joueur n'a qu'une seule tentative, et le premier à trouver marque le point automatiquement. L'hôte peut aussi donner la manche à la main, par exemple si une réponse contient une faute.

La bataille finale utilise les descriptions difficiles, sauf en mode Facile.

## Joueurs, départs et déconnexion

- Un joueur qui ferme la page est retiré automatiquement après le délai choisi par l'hôte (1, 2 ou 5 minutes, ou jamais ; 5 minutes par défaut). S'il revient avant la fin du délai, il garde sa place et ses points.
- Un joueur peut aussi cliquer sur « Quitter la partie ».
- L'hôte peut ajouter un candidat à la main (par exemple quelqu'un qui répond à l'oral sur Discord) et lui donner des points avec les boutons + et −. Les candidats ajoutés à la main ne sont jamais retirés. Si cette personne ouvre ensuite le lien avec le même pseudo, elle récupère sa place et ses points.
- Les boutons + et − marchent pour tous les joueurs, et ✕ retire un joueur de la partie.
- L'hôte peut se déconnecter avec « Se déconnecter », en bas de sa page. La partie continue sur le serveur, et il revient avec son code.

## Master (comme le maître du jeu dans un JDR)

Une autre personne peut animer la partie avec son propre accès, sans utiliser celui de l'hôte principal :

- Lien : l'adresse du site suivie de `#master`.
- Mot de passe : `lustalia`.

Le master a les mêmes commandes que l'hôte. L'hôte principal (`#hote`, code `314159`) voit si un master est connecté, et peut le déconnecter et bloquer son accès, puis le rouvrir.

## Tester sur ton PC (facultatif)

Crée un fichier `.dev.vars` qui contient la ligne `HOST_CODE=1234`, puis lance :
```
npx wrangler dev
```
Ouvre ensuite http://localhost:8787/#hote dans ton navigateur (code `1234`).

# Diazo — `BRYANN2K/diazo`, branche `main`

Fork de `kgoedecke/doop` (AGPL-3.0) axé sur la navigation et les performances
des très grands canvases (5000+ frames), plus une poignée de fiabilisations et
de fonctionnalités. Chaque PR upstream est mergée individuellement, avec ses
conflits résolus à la main pour préserver l'intention de chaque côté.

## Renommage en Diazo (2026-11-15)

doop est une marque (nom et logo, voir `docs/doop-reference.md`, « please rebrand derived
services ») : le fork s'appelle **Diazo**, dépôt `BRYANN2K/diazo` (ex-`BRYANN2K/redoop`), image
`ghcr.io/bryann2k/diazo`. Tout ce qu'un utilisateur voit est renommé (marques, textes, agent
« Diazo Agent » / `@diazo`, app desktop `Diazo.app` / `dev.bryann2k.diazo` 0.15.0, scripts
d'install). Les identifiants internes gardent `doop` pour ne casser ni données ni intégrations :
attributs `data-doop-*`, clés `doop:`, variables `DOOP_*`, `doop-secrets`, namespace et
déploiement k3s `doop`, tables, noms d'outils MCP, schéma `doop://`, exécutable `doop-desktop`,
noms de crates et de paquets, police `Doop Keys`, `.doop.json` (`.diazo.json` accepté aussi).
Alias gardés : `@doop` route vers l'agent, le sujet de guide `doop-instructions` répond comme
`diazo-instructions`, la commande `doop` du CLI et `doop-local` restent.

Après le merge, à faire à la main : renommer le dépôt GitHub en `diazo`, rendre public le
package GHCR `diazo` (premier push de `docker.yml`), redémarrer le déploiement k3s sur la
nouvelle image, puis taguer `desktop-v0.15.0`. Les shells ≤ 0.14 lisent l'ancien flux
`BRYANN2K/redoop/…/latest.json` : ils ne passent à 0.15.0 que par la redirection GitHub du
dépôt renommé (sinon : réinstaller avec le script curl).

## PRs mergées

### Performance (canvas / zoom)

| PR   | Objet                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #412 | Chargement différé du HTML des frames par page + culling des frames hors écran (les iframes hors vue sont démontées et remplacées par des placeholders).                                                              |
| #314 | Level-of-detail : budget de frames « live », les autres passent en image serveur (`frameLod.ts`, `useFrameLods`). Intégré par-dessus le culling de #412 : `live`/`image`/`none` remplace le binaire live/placeholder. |
| #434 | Optimisation du rendu pendant le zoom.                                                                                                                                                                                |
| #435 | Lecture de la bounding box du stage une fois par flush de molette (au lieu d'une par événement).                                                                                                                      |
| #436 | Optimisation zoom/pan complémentaire.                                                                                                                                                                                 |
| #437 | Les variables CSS caméra sont écrites sur le nœud qui les lit (`world`), pas sur le stage ; `--zoom` reste exposé aux règles/guides via une enveloppe `display:contents`.                                             |
| #439 | N'invalide plus le style de toute la page à chaque pas de pan.                                                                                                                                                        |

### Fiabilité

| PR   | Objet                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #399 | Récupération du renderer Chromium « wedged » (relaunch + retry). Fusionné dans l'API généralisée `createRenderer`/`withPage` de #456 ; son test dédié a été retiré, `tests/renderBrowser.test.ts` couvrant les mêmes scénarios. |
| #456 | Renderer durci : navigateur distant, page leases, files d'attente, limites de pixels et de concurrence (`renderLimits.ts`, fusion de `renderLimit.ts`), `/healthz/renderer`.                                                    |
| #277 | `edit_frame_source` : remplacement littéral dans le HTML des frames. L'helper `editFrameSource` existant a été conservé ; le test de la PR est ajouté.                                                                          |
| #390 | Correctif fiabilité complémentaire.                                                                                                                                                                                             |
| #505 | Durcissement : CSP des frames, conteneur non-root, écritures contrôlées.                                                                                                                                                        |

### Fonctionnalités

| PR   | Objet                                                                              |
| ---- | ---------------------------------------------------------------------------------- |
| #462 | Couper (⌘X) frames et calques, presse-papiers canvas partagé.                      |
| #476 | Placement d'images : taille native côté serveur, endpoint HTTP d'upload/placement. |
| #457 | OpenCode dans le sélecteur « Connect AI » (brand mark + icône).                    |
| #506 | Synchronisation des feuilles de style externes dans les frames (sync CSS).         |

Fonctionnalité propre au fork : **bibliothèques de design** (`.context/specs/design-libraries.md`),
un canvas devient une bibliothèque indexée en items et variantes, cherchée depuis ⌘F et par MCP.

## Bibliothèques de design : convertir les deux canvases existants

Les canvases vivent sur doop.design ; les copier d'abord sur l'instance du fork (étape 7.5,
`scripts/pull-library.ts`, lancé à la main et supervisé). Puis, sur l'instance :

```bash
# clés d'agent (Settings → Agent keys) dans l'environnement seulement, jamais dans un fichier
export DOOP_FROM_KEY=dpk_…   # compte doop.design qui voit le canvas
export DOOP_TO_KEY=dpk_…     # compte sur l'instance du fork
npx tsx scripts/pull-library.ts --from https://doop.design --canvas <id> --to <origine du fork> --dry-run
npx tsx scripts/pull-library.ts --from https://doop.design --canvas <id> --to <origine du fork>
```

La source n'est que lue (outils MCP `get_canvas` / `get_frame`, assets `/a/` publics). Le script
reprend où il s'est arrêté (fichier de progression dans le dossier temporaire de l'OS). Au-delà de
100 pages il s'arrête : transformer le canvas cible en bibliothèque (étape 1 ci-dessous), puis
relancer la même commande.

1. Ouvrir « Design Library » → Fichier → « Turn into a library… ». Le préréglage `sheets` est
   détecté ; vérifier le rapport (Ignored, Unreadable, Duplicates), relire les catégories proposées
   (sections `§` et noms de pages), appliquer. Aucun frame n'est modifié.
2. Attendre la fin de l'indexation (le compteur `items · variants` de la bibliothèque) ; la passe
   rendue lit ensuite les feuilles scriptées.
3. Faire de même pour « Design Library · by function ».
4. Reprendre ses catégories dans « Design Library » (décision D2) : `POST
/api/libraries/<design-library>/transfer { "fromLibraryId": "<by-function>", "dryRun": true }`,
   relire `matched`, `onlyFrom`, `onlyTo`, puis relancer sans `dryRun`. Seule la curation de « Design
   Library » est écrite ; une seconde exécution ne change rien. Archiver ensuite « by function ».

## Bibliothèques : en faire une seule avec l'IA (les 4 canvases)

But : une bibliothèque propre à partir de « Design Library », « Design Library · A UI components »,
« Design Library · B Sections & screens » et « Design Library · C Motion, type & effects ». Les
quatre canvases ne sont jamais modifiés.

1. Connecter un compte de modèle à soi (Settings → Diazo Agent : clé Claude, ChatGPT…). La curation
   tourne sur ce compte, jamais sur le tier serveur. Coût indicatif pour ~7 000 frames : environ
   120 appels (1 pour l'arbre, 1 par lot de 60 items sur le petit modèle du compte, plus quelques
   reprises).
2. Rail → Libraries → « Organise with AI ». Cocher « Design Library » en premier (c'est sa copie
   qui est gardée quand un design est en double), puis A, B, C. Nommer la bibliothèque, Start.
3. Suivre la progression (lecture des canvases, arbre, classement). La fenêtre peut être fermée :
   la tâche continue côté serveur et reprend après un redémarrage. Une erreur de compte la met en
   échec : « Retry from where it stopped ».
4. Relire l'arbre : renommer, fusionner (« Merge into… »), déplacer, supprimer une catégorie (ses
   items deviennent non classés), déplacer des items. Onglets « Unclassified » et « Duplicates »
   (doublons écartés, items déjà présents dans une autre bibliothèque).
5. « Create library » : nouveau canvas, une page par catégorie, frames copiés en grille, puis
   bibliothèque indexée. Option « Unsorted » pour garder les non classés.

Par API (session) : `POST /api/library-curations { sourceIds: [...] }`, `GET /:id`,
`GET /:id/plan`, `PATCH /:id/plan { edits }`, `POST /:id/apply`. Un agent peut lancer
`start_library_curation` et lire `get_library_curation`, mais c'est l'humain qui applique.

Avant tout import dans une bibliothèque, Diazo vérifie qu'elle (ou une autre de tes bibliothèques)
n'a pas déjà l'élément : même page importée, copie du même frame, même contenu, ou nom et texte
presque identiques. « Add to library… » propose alors Open / Import anyway / Add as a variant ;
les agents reçoivent le doublon au lieu d'importer, et peuvent demander d'abord avec `check_library`.

## PRs abandonnées

| PR   | Raison                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #299 | Ancienne implémentation de la bibliothèque de composants (~10k lignes), écrite avant qu'upstream ne livre la sienne (`componentActions`, `componentEngine`, `componentTools`, `ComponentsPanel`, migration `0052_components.sql`). La merger supprimerait l'implémentation actuelle et grefferait un second système parallèle (API serveur, panneaux, i18n). Conflit structurel non résolvable proprement — abandonnée conformément au brief. |

## Resynchroniser avec upstream

```bash
git fetch upstream
git checkout main
git merge upstream/main
# résoudre les conflits en gardant les intentions ci-dessus, puis :
bun install && bun run typecheck && bun run lint && bun run test
git push origin main   # jamais vers upstream
```

## Workflows GitHub Actions

Sur `main` (et les PR) du fork tournent : **CI** (typecheck, lint, build, tests
en 4 shards), **docker** (l'image ci-dessous), **Desktop** et **iOS** (builds de
validation, seulement quand `desktop/` ou `ios/` change ; rien n'est publié).

Gardés par `if: github.repository == 'kgoedecke/doop'`, donc inactifs ici :

- **Release Please** : le versioning d'upstream. Le fork merge avec des commits
  « Merge branch … » et ne coupe pas de release ; il échouait et créait des
  branches `release-please--*`.
- **CLA** : le CLA est celui d'upstream ; il aurait réclamé une signature sur
  nos propres PR.

`desktop-release.yml` part sur un tag `desktop-v*` (ou une PR qui le
modifie) et publie l'app desktop du fork : voir « App desktop » plus bas.
`ios-release.yml` part sur un tag `ios-v*` et demande les secrets de
signature d'upstream : ne pas pousser ces tags dans le fork.

## Image Docker

Buildée en CI (`.github/workflows/docker.yml`) et publiée sur
`ghcr.io/bryann2k/diazo` à chaque push sur `main`, avec les tags `main`, `latest`
et `sha-<commit court>` (le nom vient du dépôt, en minuscules).
Multi-arch : `linux/amd64` (le VPS k3s) et `linux/arm64` (l'install locale
sur Mac Apple silicon). Chaque arch est buildée sur un runner natif
(`ubuntu-latest`, `ubuntu-24.04-arm`), poussée par digest, puis un job
`merge` assemble le tag multi-arch.

## Détection des mises à jour (notre dépôt)

Chaque image porte son commit et sa date de build (`DOOP_BUILD_SHA` /
`DOOP_BUILD_DATE`, build-args passés par `docker.yml`), lisibles sur
`GET /api/version` (public) et dans Settings → General → About. Le serveur
(`server/updateCheck.ts`) demande à l'API publique GitHub, sans token, le
dernier commit de `main` dont le run `docker.yml` a réussi (donc une image
existe), puis le compare au commit en cours : à jour, N commits de retard,
en avance, divergé ou inconnu. Réponse gardée 1 h (échec 15 min, quota
épuisé jusqu'au reset), revalidée par ETag : au plus ~2 requêtes/heure sur
les 60 autorisées. Les admins de l'instance (et l'utilisateur d'une install
locale) voient la carte « Update available » avec la commande adaptée :
`diazo-local update`, `docker compose pull && docker compose up -d`, ou
`kubectl -n doop rollout restart deploy/doop`. Réglages : `DOOP_UPDATE_CHECK`,
`DOOP_UPDATE_REPO`, `DOOP_UPDATE_BRANCH`, `DOOP_INSTALL` (`.env.example`).

### App desktop

La carte vient de la page, donc elle s'affiche aussi dans l'app desktop,
empilée au-dessus de la carte du shell. Le shell, lui, se met à jour depuis
**notre** dépôt (depuis la 0.14.0) :

- **Flux** : `plugins.updater.endpoints` (WebKit et Chromium) =
  `https://github.com/BRYANN2K/diazo/releases/download/desktop-updates/latest.json`,
  une prerelease fixe `desktop-updates` que `desktop-release.yml` crée puis
  réécrit à chaque tag. Choisie plutôt que `releases/latest/download/…` :
  « latest » désigne la dernière release non-prerelease du dépôt, quelle
  qu'elle soit (une release web ou iOS la détournerait), alors que la
  prerelease fixe ne bouge que pour le desktop, et le job refuse d'y remettre
  une version plus ancienne (relance d'un vieux tag).
- **Clé** : une paire minisign propre au fork (id `B1375F7E88B8FC72`, créée sous le nom redoop),
  générée en mémoire le 2026-11-15 et jamais écrite sur disque : la privée et
  son mot de passe sont seulement dans les secrets `TAURI_SIGNING_PRIVATE_KEY`
  et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` de `BRYANN2K/diazo` (illisibles une
  fois posés). La publique est `plugins.updater.pubkey`, et aussi `PUBKEY`
  dans `scripts/install-desktop.sh`. Perdre la clé = générer une nouvelle
  paire et réinstaller une fois par le script curl ; aucune perte de données.
- **Install** : `curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install-desktop.sh | sh`
  (macOS, universel). Pas de signature Apple : un fichier téléchargé par curl
  n'a pas l'attribut de quarantaine, Gatekeeper ne bloque donc pas l'app
  (signée ad hoc). Le script vérifie `SHA256SUMS` (et la signature minisign si
  `minisign` est installé), quitte l'app, remplace `Diazo.app` dans
  `/Applications` (sinon `~/Applications`), ne touche jamais
  `~/Library/Application Support/dev.bryann2k.diazo` ni `design.doop.desktop`. Testé sans réseau par
  `tests/installDesktop.test.ts`.
- **Shells installés depuis doop.design** : ils gardent la clé et le flux
  d'upstream et ne passeront jamais seuls sur les nôtres. Une réinstallation
  par le script curl suffit (connexion et serveur choisi conservés).
- **Serveur** : l'app ouvre toujours doop.design par défaut (`DOOP_APP_URL`
  inchangé, sinon `updates.rs` couperait les mises à jour) ; la roue dentée de
  l'écran de connexion la pointe sur l'instance du fork.

#### Couper une release desktop

1. Monter la version dans `desktop/package.json`, les deux `tauri.conf.json`,
   les deux `Cargo.toml` (+ la ligne du paquet dans chaque `Cargo.lock`) et
   `.release-please-manifest.json` ; noter le changement dans
   `desktop/CHANGELOG.md`. `updater-config.sh` refuse un tag dont la version
   diffère des `tauri.conf.json`.
2. Merger dans `main`, puis :

   ```bash
   git tag desktop-vX.Y.Z origin/main && git push origin desktop-vX.Y.Z
   ```

3. `desktop-release.yml` construit le DMG universel (Chromium/CEF, ~1 h), le
   setup Windows et les paquets Linux, non signés pour Apple et Windows (pas
   de secrets `APPLE_*` ni de variables `AZURE_*` ici), signe les paquets de
   mise à jour avec la clé, attache tout plus `SHA256SUMS` et `latest.json` à
   la release `desktop-vX.Y.Z`, puis copie `latest.json` sur
   `desktop-updates`. Les apps installées le voient sous 24 h (ou Diazo →
   Check for Updates…).

## Déploiement k3s (Tailscale only)

Manifests dans `deploy/k3s/`. Le Service reste `ClusterIP` ; l'exposition se
fait exclusivement via Tailscale Serve côté hôte. Pas d'ingress, pas de
cloudflared, pas de Funnel.

Instance déployée : `https://bryann2k-infra-prod.tail35c61f.ts.net:8850`
(Serve :8850 → `svc/doop` ClusterIP :4400, tailnet only).

```bash
# 0) vérifier le disque (>= 3 Go libres)
df -h /

# 1) namespace + Postgres + app
kubectl apply -f deploy/k3s/namespace.yaml

# 2) secrets (jamais dans le repo)
DB_PASS=$(openssl rand -hex 16)
kubectl -n doop create secret generic doop-secrets \
  --from-literal=POSTGRES_PASSWORD="$DB_PASS" \
  --from-literal=DATABASE_URL="postgres://doop:$DB_PASS@postgres.doop.svc.cluster.local:5432/doop" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=BETTER_AUTH_URL="https://bryann2k-infra-prod.tail35c61f.ts.net:8850" \
  --from-literal=SIGNUP_EMAIL_DOMAINS=""   # ouvert ; à restreindre après le 1er compte

kubectl apply -f deploy/k3s/postgres.yaml -f deploy/k3s/doop.yaml
kubectl -n doop rollout status deploy/doop

# 3) exposition Tailscale Serve (sur l'hôte, comme les autres services)
tailscale serve --bg --https=8850 http://$(kubectl -n doop get svc doop -o jsonpath='{.spec.clusterIP}'):4400

# 4) vérifs
curl -sk https://bryann2k-infra-prod.tail35c61f.ts.net:8850/healthz
curl -sk https://bryann2k-infra-prod.tail35c61f.ts.net:8850/mcp   # 405 = endpoint MCP présent (POST only)
```

### Image GHCR

Le package `ghcr.io/bryann2k/diazo` doit être **public** : le cluster le tire
directement (`imagePullPolicy: Always`). Au premier déploiement, le package
était encore privé (défaut GHCR) et l'image avait été importée à la main dans
containerd — si cela devait se reproduire :

```bash
docker build --platform linux/amd64 -t ghcr.io/bryann2k/diazo:main .
docker save ghcr.io/bryann2k/diazo:main | gzip > doop-image.tar.gz
scp doop-image.tar.gz <vps>:/tmp/
ssh <vps> 'sudo k3s ctr -n k8s.io images import /tmp/doop-image.tar.gz'
```

## Install locale (Mac, Apple `container`)

Deux façons de faire tourner doop : **local** (une personne, un Mac) et
**hébergé** (k3s + Tailscale ci-dessus, ou `docker compose up`).

```bash
curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install-local.sh | sh
```

- `scripts/install-local.sh` (POSIX sh) : vérifie macOS + Apple silicon +
  `container`, lance `container system start`, crée `~/.diazo/` (`diazo.env` en
  600 avec `BETTER_AUTH_SECRET` et `SECRETS_ENCRYPTION_KEYS` générés sur le Mac,
  `data/`), tire l'image arm64, lance **un seul** conteneur sur
  `127.0.0.1:4400` (conteneur `diazo`) avec `~/.diazo/data` monté sur `/app/data`. Une
  install d'avant le renommage garde `~/.doop` (et `doop.env`) là où il est : rien n'est déplacé.
- Pas de `DATABASE_URL` : le serveur prend PGlite (`/app/data/pg`), les uploads
  vont dans `/app/data/assets`. Aucun changement de code nécessaire.
- Relancer la commande = mise à jour (pull + recréation), données et secrets
  gardés. `~/.diazo/bin/diazo-local start|stop|restart|status|logs|update|uninstall`
  (`doop-local` reste un lien vers lui).
- Sans image arm64 publiée, le script prend l'amd64 sous Rosetta ; `--build`
  construit l'image sur le Mac depuis les sources.
- Testé sans conteneur par `tests/installLocal.test.ts` (stubs de `container`,
  `uname`, `curl`).

## Live instance (2026-11-12)

- URL (tailnet only): https://bryann2k-infra-prod.tail35c61f.ts.net:8850
- MCP: https://bryann2k-infra-prod.tail35c61f.ts.net:8850/mcp
- Exposure: `tailscale serve --bg --https=8850 http://<doop ClusterIP>:4400` on bryann2k-infra. No Funnel, no cloudflared.
- k3s namespace `doop`: `postgres-0` + `deploy/doop` (image `ghcr.io/bryann2k/diazo:main`, public).
- Dropped PR: #299 (component library). It would have added a second, parallel component system.

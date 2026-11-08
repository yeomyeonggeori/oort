<p align="center"><a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.es.md">Español</a> · <b>Français</b></p>
<p align="center"><sub>Traduction (bêta) — la version anglaise fait foi.</sub></p>
<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/mark/oort-mark-white.svg"><img src="docs/brand/mark/oort-mark-black.svg" width="64" alt="Le logo d’oort : un anneau avec une queue de bulle de dialogue et un satellite"></picture></p>
<h1 align="center">oort</h1>
<p align="center"><strong>Une messagerie auto-hébergée où les agents sont des membres, pas des bots.</strong></p>
<p align="center"><a href="docs/architecture/overview.md">Architecture</a> · <a href="docs/SELF_HOST.md">Auto-hébergement</a> · <a href="docs/adr/">Décisions (ADR)</a> · <a href="SECURITY.md">Sécurité</a> · <a href="CHANGELOG.md">Journal des modifications</a> · <a href="LICENSE">Apache-2.0</a></p>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/channel-en-dark.png"><img src="docs/assets/readme/channel-en-light.png" width="100%" alt="Un canal de mise en production dans l’app web d’oort : quatre personnes et l’agent Kometto discutent ; Kometto a publié un résumé de l’environnement de staging et rédige maintenant les notes de version, signalé comme en cours dans la barre latérale et au-dessus de la zone de saisie"></picture><br><sub><em>Des personnes et un agent dans un même canal : Kometto a répondu, et sa tâche suivante apparaît comme en cours. Certaines parties de l’app ne sont encore qu’en coréen.</em></sub></p>

oort est une messagerie d’équipe que vous faites tourner sur votre propre serveur. Les personnes et les agents IA partagent les mêmes canaux. Un agent est un membre de l’espace de travail (`member.kind = agent`) : il figure dans la même liste et avec les mêmes droits qu’une personne, au lieu d’être un bot greffé de l’extérieur. Quand un agent travaille, son exécution s’affiche dans le canal et vous pouvez l’arrêter. Quand il veut faire quelque chose qui demande une autorisation, une personne l’approuve ou la refuse directement dans la conversation, et la décision y reste.

## Ce qui fonctionne aujourd’hui

La version actuelle est [v0.1.45](https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.45) (l’image du serveur et du web). Chaque version figure dans le [journal des modifications](CHANGELOG.md).

- Canaux, fils de discussion, messages directs, réactions, émoticônes et recherche, sur le web, dans l’app de bureau macOS et dans l’app iPhone
- Des agents membres : mentionnez-en un, suivez son exécution dans le canal, arrêtez-la, et approuvez ou refusez ce qu’il demande à faire
- Vos propres connexions IA : clés d’API, un runtime d’agents Hermes sur le même serveur, ou un backend local compatible OpenAI. oort orchestre et consigne le travail ; ce n’est pas le fournisseur d’IA
- Les fichiers restent sur le volume de votre propre serveur, ou dans un Drive partagé Google qui vous appartient
- L’app est en coréen et en anglais ; certaines parties ne sont encore qu’en coréen

Les apps de bureau et iPhone sont des versions de test pour notre propre équipe. Il n’y a pas encore de téléchargement public ni d’instance publique hébergée : notre équipe passe d’abord ([objectif A](docs/adr/0187-goal-a-team-daily-desktop-ios.md)), et les versions publiques attendent la [porte des stores (M7)](docs/cicd/03-store-readiness-gate.md).

## L’installer sur votre propre serveur

Il vous faut Docker et git. L’API, le relais, le worker, les migrations et l’app web sont livrés dans une seule image.

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort && cd oort
scripts/self_host_env.sh   # écrit votre fichier env et affiche votre première connexion
# puis lancez la ligne compose affichée et ouvrez l'adresse locale indiquée
```

Ou confiez la tâche à votre agent. Collez ceci :

```text
Sur cette machine, sous le compte de cet utilisateur uniquement : lis
https://raw.githubusercontent.com/yeomyeonggeori/oort/main/docs/SELF_HOST_AGENT.md
et suis son contrat §0 pour installer oort.
Ne déclare avoir terminé que lorsque `scripts/oort doctor` est en PASS.
```

Les images publiées, une adresse publique et Railway sont décrits dans [`docs/SELF_HOST.md`](docs/SELF_HOST.md).

## Vos données et vos identifiants

- **Votre serveur est la source de vérité.** Les messages, les approbations, l’état des exécutions et le journal d’audit vivent dans votre PostgreSQL. Les tiers n’apparaissent que là où vous les choisissez : le backend IA que vous choisissez reçoit le contexte de travail dont il a besoin, et le relais de notifications push facultatif, seul service que nous exploitons pour vous, ne reçoit que des identifiants et des données d’acheminement, jamais le corps des messages, les prompts, le détail des approbations ni les pièces jointes ([ADR-0120](docs/adr/0120-push-notification-boundary.md)).
- **Les identifiants restent scellés.** Les connexions par abonnement (ChatGPT/Codex, Claude) appartiennent à votre volume Hermes : oort refuse de créer de nouveaux liens de jetons d’abonnement, et les anciens restent scellés jusqu’à leur suppression. Une clé d’API ou un bearer Hermes que vous confiez à oort est stocké sous forme de texte chiffré AES-256-GCM avec sa propre clé maîtresse, jamais en clair, et n’est réaffiché qu’à hauteur de ses quatre derniers caractères au plus ([ADR-0004](docs/adr/0004-codex-oauth-hermes-provider-boundary.md) · [preuves, en coréen](docs/security/README.ko.md#자격증명과-provider)).
- **Pas de chiffrement de bout en bout.** Le serveur, et quiconque l’exploite, peut lire le contenu des messages : la recherche et les agents en ont besoin.
- **Ni audité, ni certifié.** Pas d’audit de sécurité par un tiers, pas de test d’intrusion, pas de certification SOC 2 ni ISO ([limites actuelles, en coréen](docs/security/README.ko.md#현재-한계와-도입-시-확인할-점)). Signalez les problèmes de sécurité en privé, comme l’indique [SECURITY.md](SECURITY.md).

## Pour aller plus loin

- [Architecture](docs/architecture/overview.md) : une base de données et un seul chemin d’écriture (REST → PostgreSQL → outbox → relais → Centrifugo), et les règles qui le tiennent
- [Décisions (ADR)](docs/adr/) : pourquoi le code est comme il est
- [Auto-hébergement](docs/SELF_HOST.md) et la [posture de sécurité](SECURITY.md#security-posture)
- Compiler et tester depuis les sources : `npm ci && npm --prefix clients/web ci && npm --prefix clients/mobile ci`, puis `make build && make test` (Rust 1.88+). Ce qui est vérifié avant qu’un changement n’entre : [validation du développement](docs/runbooks/development-validation.md)
- [Journal des modifications](CHANGELOG.md) et [guide de contribution](CONTRIBUTING.md)

## Licence

oort est distribué sous licence [Apache-2.0](LICENSE) ([NOTICE](NOTICE)). Les contributions suivent le Developer Certificate of Origin, sans CLA ([CONTRIBUTING.md](CONTRIBUTING.md)), et nous appliquons le [Contributor Covenant](CODE_OF_CONDUCT.md). Les attributions des dépendances sont dans [`legal/THIRD_PARTY_NOTICES.md`](legal/THIRD_PARTY_NOTICES.md).

<sub>Le dépôt garde son nom de travail, <b>momo</b> ; le produit s’appelle oort.</sub>

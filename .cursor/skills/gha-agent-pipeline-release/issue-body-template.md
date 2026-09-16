## Contexte / Context

La bibliothèque [`iGLOO-be/gha-agent-pipeline`](https://github.com/iGLOO-be/gha-agent-pipeline) a publié **[vX.Y.Z](https://github.com/iGLOO-be/gha-agent-pipeline/releases/tag/vX.Y.Z)**. Ce dépôt est encore épinglé sur **`@vOLD`** (remplacer par le pin détecté).

## Contenu de la release

<!-- Bullets from release notes + PR/issue links -->

1. …
2. …

<!-- If OLD is more than one minor behind, add a short “since your current pin” subsection -->

## Pourquoi mettre à jour

- …

## Travail demandé

Remplacer **toutes** les références `iGLOO-be/gha-agent-pipeline/...@vOLD` par **`@vX.Y.Z`**.

| Fichier                             | Éléments          |
| ----------------------------------- | ----------------- |
| `.github/workflows/agent.yml`       | `dispatch.yml`    |
| `.github/workflows/agent-phase.yml` | `agent-phase-run` |
| …                                   | …                 |

```bash
rg 'gha-agent-pipeline@v0' .
rg 'v0\.OLD' .
```

**Ne pas** changer setup, secrets, ou noms de workflows consommateur — **bump de tag uniquement**.

## Vérification

1. Aucun pin library obsolète (`@vOLD`).
2. CI verte sur la PR agent.
3. Documentation (README / AGENTS / ops) alignée sur `@vX.Y.Z`.

## Références

- Release : https://github.com/iGLOO-be/gha-agent-pipeline/releases/tag/vX.Y.Z
- Consumer contract : https://github.com/iGLOO-be/gha-agent-pipeline#consumer-contract-v01

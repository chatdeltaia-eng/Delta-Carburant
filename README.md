# DeltaCarburant

L'application utilise PostgreSQL directement, sans Prisma ni autre ORM.
Le classeur Excel sert à initialiser la base ; après import, PostgreSQL devient la
source de vérité et les données sont modifiables par l'application.

## Contenu

- `sql/001_extensions.sql` : extensions PostgreSQL nécessaires.
- `sql/002_schema.sql` : tables métier, import, historique et audit.
- `sql/003_import_najib.sql` : normalisation et intégration d'un lot Excel.
- `scripts/xlsx_to_copy.py` : lecture XLSX sans dépendance Python externe.
- `scripts/import_najib.sh` : import transactionnel du classeur dans PostgreSQL.
- `.env.example` : paramètres attendus, sans secret.
- `apps/api` : API NestJS avec JWT, RBAC, Swagger et requêtes SQL natives.
- `apps/web` : interface Next.js responsive en français.

## Préparation

PostgreSQL 16 ou supérieur et le client `psql` sont requis. Créer une base vide,
puis définir les secrets localement :

```bash
cp .env.example .env
# Modifier .env sans le committer.
set -a; . ./.env; set +a
createdb "$PGDATABASE"
psql -v ON_ERROR_STOP=1 -f sql/001_extensions.sql
psql -v ON_ERROR_STOP=1 -f sql/002_schema.sql
psql -v ON_ERROR_STOP=1 -f sql/005_application_modules.sql
```

## Import initial

```bash
./scripts/import_najib.sh /chemin/vers/NAJIB.xlsx
```

L'import :

1. enregistre un lot et l'empreinte SHA-256 du fichier ;
2. conserve chaque ligne source dans `import_row` ;
3. crée ou met à jour sociétés, départements, bénéficiaires et véhicules ;
4. chiffre numéros de carte et PIN avec `pgcrypto` ;
5. crée les cartes et leur affectation courante ;
6. place les lignes ambiguës dans `data_quality_issue` ;
7. écrit les changements dans `audit_log`.

Un même fichier ne peut pas être importé deux fois par erreur. Un second fichier
de correction crée un nouveau lot et met à jour les fiches identifiées, tout en
conservant la valeur précédente dans l'audit.

## Contrôles après import

```sql
SELECT status, count(*) FROM fuel_card GROUP BY status ORDER BY status;
SELECT severity, issue_code, count(*)
FROM data_quality_issue
WHERE resolved_at IS NULL
GROUP BY severity, issue_code
ORDER BY severity, issue_code;
SELECT * FROM v_fuel_card_list ORDER BY company_code, masked_card_number;
```

La vue `v_fuel_card_list` ne révèle ni numéro complet ni PIN. L'accès aux colonnes
chiffrées devra être interdit aux rôles applicatifs ordinaires.

## Lancement de l'application

Après avoir renseigné `.env`, lancer les deux services dans des terminaux séparés :

```bash
cd apps/api
npm install
set -a; . ../../.env; set +a
npm run start:dev
```

```bash
cd apps/web
npm install
npm run dev
```

L'interface est disponible sur `http://localhost:3000`, l'API sur
`http://localhost:3001/api/v1` et Swagger sur `http://localhost:3001/docs`.

Les commandes de vérification sont `npm test` et `npm run build` dans l'API,
puis `npm run build` dans l'application web.

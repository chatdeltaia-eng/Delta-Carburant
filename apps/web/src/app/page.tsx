"use client";

import { FormEvent, Fragment, ReactNode, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx";
import styles from "./page.module.css";

function TopLayerDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className={styles.notificationDialog}
      aria-label="Centre de notifications"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      {children}
    </dialog>
  );
}

type Role =
  "SUPER_ADMIN" | "DIRECTION_GENERAL" | "ZIN_FINANCE" | "NAJIB_ASSIGNER";
type User = { id: string; name: string; role: Role; email: string };
type View =
  | "dashboard"
  | "reports"
  | "cards"
  | "beneficiaries"
  | "vehicles"
  | "drivers"
  | "fuelPrices"
  | "transactions"
  | "requests"
  | "mileage"
  | "anomalies"
  | "complaints"
  | "returns"
  | "documents"
  | "settings";
type CardStatus =
  | "TO_ASSIGN"
  | "ASSIGNED"
  | "DISTRIBUTED"
  | "ACTIVE"
  | "SAFE"
  | "SUSPENDED"
  | "LOST"
  | "STOLEN"
  | "OPPOSED"
  | "REPLACED";
type FinanceStatus = "PENDING" | "CONFIRMED" | "REJECTED";
type Card = {
  id: string;
  masked_card_number: string;
  company_code: string;
  beneficiary: string | null;
  department?: string | null;
  registration: string | null;
  vehicle_model?: string | null;
  monthly_limit: number;
  status: CardStatus;
  finance_status: FinanceStatus;
  opposition_reason?: string;
  created_at: string;
  updated_at: string;
  old_card_id?: string;
  replacement_card_id?: string;
  card_category: "PERSONALIZED" | "OFF_PARK";
  activation_locked?: boolean;
  consumed_amount?:number;
  total_consumed_amount?:number;
  consumption_rate?:number;
  responsible_role?:string;
  responsible_name?:string;
  responsible_user_id?:string;
  company_id?:string;
  latest_action_type?:string;
  latest_action_responsible?:string;
  initial_action?:string;
};
type Row = { id: string; [key: string]: string | number };
type Modal =
  | "card"
  | "cardAction"
  | "import"
  | "request"
  | "mileage"
  | "beneficiary"
  | "vehicle"
  | "driver"
  | "fuelPrice"
  | "editRow"
  | "editTransaction"
  | "settings"
  | null;
type Notification = {
  id: string;
  target: Role;
  title: string;
  message: string;
  view: View;
  read: boolean;
  createdAt: string;
};

const toNotification = (row: Record<string, unknown>, role: Role): Notification => ({
  id: String(row.id),
  target: role,
  title: String(row.title ?? "Notification"),
  message: String(row.message ?? ""),
  view: String(row.targetView ?? "dashboard") as View,
  read: Boolean(row.readAt),
  createdAt: new Date(String(row.createdAt)).toLocaleString("fr-MA"),
});

type WorkflowStep = {
  number: string;
  view: View;
  title: string;
  description: string;
};

type IconName = "dashboard"|"reports"|"cards"|"users"|"vehicle"|"driver"|"transactions"|"requests"|"mileage"|"fuel"|"alert"|"settings"|"logout"|"bell"|"sum"|"safe"|"active"|"plus"|"check"|"transfer";
function AppIcon({name,size=20}:{name:IconName;size?:number}) {
  const paths:Record<IconName,React.ReactNode>={
    dashboard:<><path d="M3 13h8V3H3v10Zm0 8h8v-5H3v5Zm11 0h7V11h-7v10Zm0-18v5h7V3h-7Z"/></>, reports:<><path d="M4 20V10m5 10V4m6 16v-7m5 7H2"/></>,
    cards:<><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M3 9h18M7 15h4"/></>, users:<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    vehicle:<><path d="m5 17-2-1v-5l2-5h14l2 5v5l-2 1M5 17h14M6 11h12M7 20v1M17 20v1"/><circle cx="7" cy="15" r="1"/><circle cx="17" cy="15" r="1"/></>, driver:<><circle cx="12" cy="7" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0M9 17l3 3 3-3"/></>,
    transactions:<><path d="M7 7h13l-3-3m3 3-3 3M17 17H4l3 3m-3-3 3-3"/></>, requests:<><path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/></>, mileage:<><circle cx="12" cy="13" r="8"/><path d="m12 13 4-4M7 3h10M12 5V3"/></>,
    fuel:<><path d="M5 21V4a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v17M3 21h15M8 6h5v5H8zM16 7h2l3 3v7a2 2 0 0 1-4 0v-4"/></>, alert:<><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5m0 3h.01"/></>,
    settings:<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a7.8 7.8 0 0 0 .1-6l2-2.3-4.2-4.2-2.3 2a7.8 7.8 0 0 0-6 0l-2.3-2L2.5 6.7l2 2.3a7.8 7.8 0 0 0 0 6l-2 2.3 4.2 4.2 2.3-2a7.8 7.8 0 0 0 6 0l2.3 2 4.2-4.2-2.1-2.3Z"/></>, logout:<><path d="M10 17l5-5-5-5M15 12H3M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/></>,
    bell:<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>, sum:<><path d="M18 4H6l6 8-6 8h12"/></>, safe:<><rect x="4" y="7" width="16" height="14" rx="2"/><path d="M8 7V5a4 4 0 0 1 8 0v2M12 12v4"/></>, active:<><path d="M20 6 9 17l-5-5"/></>, plus:<><path d="M12 5v14M5 12h14"/></>, check:<><path d="m5 12 4 4L19 6"/></>, transfer:<><path d="M7 7h13l-3-3m3 3-3 3M17 17H4l3 3m-3-3 3-3"/></>,
  };
  return <svg className={styles.appIcon} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

// Browser requests stay on the same origin. Next.js proxies this path to the
// API service, so the API hostname does not need to be exposed to clients.
const API = "/api/v1";
const frenchDate = (value: unknown, withTime = false) => {
  if (value === null || value === undefined || value === "") return "—";
  const raw = String(value).trim();
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.\d{3})?Z)?$/);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const parsed = value instanceof Date ? value : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return withTime
    ? parsed.toLocaleString("fr-FR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" })
    : parsed.toLocaleDateString("fr-FR", { day:"2-digit", month:"2-digit", year:"numeric" });
};
const tableValue = (value: string | number | undefined) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    ? frenchDate(value, !value.includes("T00:00:00"))
    : value ?? "—";
const requestStatus: Record<string, string> = {
  SUBMITTED: "EN_ATTENTE_ZIN",
  UNDER_REVIEW: "EN_ATTENTE_ZIN",
  APPROVED: "VALIDEE_ZIN",
  REJECTED: "REFUSEE_ZIN",
  CANCELLED: "ANNULEE_NAJIB",
};
const roleName: Record<string, string> = {
  NAJIB_ASSIGNER: "Responsable hors parc",
  ZIN_FINANCE: "Zin",
  DIRECTION_GENERAL: "DG",
  SUPER_ADMIN: "Super Admin",
};
const requestTracking = (row: Record<string, unknown>) => {
  const cardAction = String(row.cardAction ?? "");
  const cardStatus = String(row.cardStatusAction ?? "");
  const statusLabels: Record<string, string> = {
    SUSPENDED: "Carte bloquée", ACTIVE: "Carte débloquée", DISTRIBUTED: "Carte distribuée",
    OPPOSED: "Carte mise en opposition", LOST: "Carte déclarée perdue", STOLEN: "Carte déclarée volée",
    REPLACED: "Carte remplacée",
  };
  if (cardAction) {
    const label = cardAction === "SOFT_DELETE" ? "Carte archivée" : cardAction === "REPLACE" ? "Carte remplacée" : cardAction === "LIMIT_CHANGE" ? "Plafond augmenté" : cardAction==="CARD_FUNDING"?"Carte alimentée":statusLabels[cardStatus] ?? "Carte mise à jour";
    const author = roleName[String(row.cardActionByRole)] ?? "Utilisateur";
    const date = row.cardActionAt ? new Date(String(row.cardActionAt)).toLocaleString("fr-MA") : "";
    return `${label} par ${author}${date ? ` · ${date}` : ""}`;
  }
  const status = String(row.status ?? "");
  if(status==="UNDER_REVIEW") return `Double autorisation · Zin ${row.zinApproved?"✓":"en attente"} · DG ${row.dgApproved?"✓":"en attente"}`;
  const authorRole = status === "CANCELLED" ? row.requestedByRole : row.decisionByRole ?? row.requestedByRole;
  const label = status === "APPROVED" ? "Demande validée" : status === "REJECTED" ? "Demande refusée" : status === "CANCELLED" ? "Demande annulée" : "Demande créée";
  const dateValue = status === "SUBMITTED" ? row.createdAt : row.decisionDate ?? row.createdAt;
  return `${label} par ${roleName[String(authorRole)] ?? "Utilisateur"} · ${new Date(String(dateValue)).toLocaleString("fr-MA")}`;
};
const toRequestRow = (row: Record<string, unknown>): Row => ({
  id: String(row.id),
  numero: String(row.requestNumber ?? "—"),
  type: String(row.requestType) === "LIMIT_CHANGE" ? "Augmentation de plafond" : String(row.requestType)==="CARD_FUNDING"?"Alimentation de carte":String(row.requestType)==="ASSIGNMENT_CHANGE"?(String(row.requestedCardStatus)==="SAFE"?"Mise en coffre":"Distribution de carte"):"Nouvelle carte",
  beneficiaire: String(row.beneficiary ?? "—"),
  departement: String(row.department ?? "—"),
  voiture: String(row.vehicle ?? "—"),
  plafond: Number(row.requestedLimit ?? 0),
  plafondActuel: Number(row.currentLimit ?? 0),
  carte: String(row.cardNumber ?? "—"),
  carteSource:String(row.sourceCardNumber??"—"),
  dateDemande: row.createdAt ? new Date(String(row.createdAt)).toLocaleString("fr-FR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit", second:"2-digit" }) : "—",
  demandeur: String(row.requestedByName ?? "—"),
  raison: String(row.reason ?? "—"),
  statut: requestStatus[String(row.status)] ?? String(row.status ?? "—"),
  motif: String(row.decisionReason ?? row.reason ?? "—"),
  dateDecision: row.decisionDate ? new Date(String(row.decisionDate)).toLocaleString("fr-FR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit", second:"2-digit" }) : "—",
  decideur: String(row.decisionByName ?? "—"),
  suivi: requestTracking(row),
  zinValide: row.zinApproved ? "Oui" : "Non",
  dgValide: row.dgApproved ? "Oui" : "Non",
  remiseEcheance: String(row.handoverDeadline ?? ""),
  remiseSignee: row.handoverSignedAt ? "Oui" : "Non",
  remiseExpiree: row.handoverExpiredAt ? "Oui" : "Non",
  recu: String(row.receiptNumber ?? "—"),
});
const initialCards: Card[] = [];
const seeds: Record<string, Row[]> = {
  beneficiaries: [],
  /* Le parc vient exclusivement de PostgreSQL. Ne jamais remettre ici
     l'ancienne liste statique : elle réapparaîtrait dès qu'une requête API
     échoue et serait alors confondue avec le référentiel actif. */
  vehicles: [],
  /*
1|945TU144|CRAFTER|DC|03/04/2010|DC|R.A.S|DCD|VOLKSWAGEN 2EH1B5|RAMZI SOLTANI
2|5626TU155|PARTNER|DC|07/12/2011|DC|R.A.S|DC|PEUGEOT GBWJYB1P|AYOUB
3|5629TU155|PARTNER|DC|07/12/2011|DC|R.A.S|DCD|PEUGEOT GBWJYB1P|RIDHA BEN KHLIFA
4|1673TU163|DUCATO|TCM|13/12/2012|HANNIBAL-LEAS|20/11/2017|TCM|FIAT 250 CCMFCBX|MONDHER DHAWAHRI
5|7992TU166|NEMO|DC|25/06/2013|DC|R.A.S|DC|CITROEN AA8HSC|ISSAM - MAINTENANCE
6|5266TU168|CLIO|DC|18/09/2013|DC|R.A.S|DC|RENAULT 5ROKOH|TAHAR DENGUIR
7|6625TU171|AVANZA|DC|13/03/2014|DC|R.A.S|DC|TOYOTA F651LMGQMF|SCE-MAINTENANCE-PARC AUTO
8|3555TU173|CRAFTER|DC|20/05/2014|DC|R.A.S|DCD|VOLKSWAGEN|EN PANNE - CHADLY MECNO
9|3557TU173|CRAFTER|DC|20/05/2014|DC|R.A.S|DCD|VOLKSWAGEN 2EFH1F5|SKANDER SADEK
10|2472TU177|NEMO|IKIT|07/11/2014|IKIT|R.A.S|DC|CITROEN NEMO|WALID TURKI
11|723TU181|SEAT|DCD|07/05/2015|DCD|R.A.S|DC|SEAT LEON|CHEDLY WISSAM GHARBI
12|688TU187|CAMION|IKIT|02/02/2016|IKIT|R.A.S|IKIT|CAMION HYUNDAI|MALEK
13|6625TU189|CRAFTER|TCM|02/05/2016|ZITOUNA-LEAS|01/06/2021|TCM|CRAFTER|EN PANNE - CHADLY MECNO
14|7085TU189|MAZDA 2|TCM|03/06/2016|TCM|R.A.S|TCM|MAZDA 2|AHMED GARA
15|8667TU196|DUCATO|DCD|19/04/2017|DCD|R.A.S|TCM|FIAT DUCATO|CHAFIK SABBAHI
16|6499TU197|TIGUAN|IKIT|18/05/2017|IKIT|R.A.S|IKIT|TIGUAN|JAWHAR DENGUIR
17|9247TU197|TATA|DC|23/05/2017|DC|R.A.S|DC|TATA|AHMED MANSOUR
18|671TU198|MAZDA|DC|05/06/2017|HANNIBAL-LEAS|20/05/2022|DC|MAZDA 9|TAHER DENGUIR
19|4162TU200|NEMO|DCD|29/09/2017|DCD|R.A.S|IKIT|CITROEN NEMO|IKIT-SFAX
20|3986TU202|NEMO|DC|27/12/2017|DC|R.A.S|DCD|CITROEN NEMO|METREUR - CHARGUIA - EZZEDDINE
21|1155TU205|DUCATO|TCM|08/05/2018|HANNIBAL-LEAS|05/05/2022|TCM|FIAT 250 CCMFCBX|EN PANNE - BEL AOUED AUTO
22|8839TU210|MICRO-BUS|DC|24/05/2019|ZITOUNA-LEAS|29/05/2024|DC|H 350 MICRO BUS|MED FELFEL
23|8700TU214|FIORINO|TCM|30/01/2020|HANNIBAL-LEAS|20/12/2023|DC|FIAT FIORINO|KACEM - PROMOTION
24|8698TU214|FIORINO|DC|31/01/2020|HANNIBAL-LEAS|20/12/2023|DC|FIAT FIORINO|WALID TURKI
25|9127TU214|FIORINO|IKIT|31/01/2020|HANNIBAL-LEAS|20/12/2023|DC|FIAT FIORINO|NIZAR MAALEM / YASSINE
26|5102TU217|DMAX|TCM|12/03/2020|TCM|R.A.S|DCD|ISUZU DMAX|MOHAMED AMAYED
27|6987TU219|T.KING|DC|10/12/2020|DC|R.A.S|DC|T.KING|SEDDIK
28|2646TU221|DONGFENG|IKIT|10/02/2021|ZITOUNA-LEAS|15/02/2026|DC|DONGFENG|EN PANNE - BEL AOUED AUTO
29|7224TU227|HYUNDAI H350|DC|11/02/2022|HANNIBAL-LEAS|20/12/2026|TCM|HYUNDAI H350|MOHAMED HAMMAMI
30|7223TU227|HYUNDAI H350|TCM|11/02/2022|HANNIBAL-LEAS|20/12/2026|DCD|HYUNDAI H350|CHAFIK SABBAHI
31|9895TU227|FIORINO|DCD|26/03/2022|HANNIBAL-LEAS|25/01/2027|IKIT|FIAT FIORINO|WAEL KROUT
32|9894TU227|FIORINO|DCD|26/03/2022|HANNIBAL-LEAS|25/01/2027|DCD|FIAT FIORINO|AYMEN NECHI - METREUR - HAMMAMET
33|9896TU227|FIORINO|DC|26/03/2022|HANNIBAL-LEAS|19/01/2027|DCD|FIAT FIORINO|SHOW ROOM DJERBA
34|8198TU229|TOYOTA|TCM|13/05/2022|ZITOUNA-LEAS|12/05/2027|TCM|TOYOTA RAV 4|FAKHRI DENGUIR
35|7726TU231|FIORINO|IKIT|22/08/2022|AL BARAKA-LEAS|20/06/2027|DCD|FIAT FIORINO|YAHYAOUI ABDERAHMEN
36|9313TU231|OPEL|DC|30/08/2022|AL BARAKA-LEAS|20/07/2027|DC|OPEL MOKKA|HOUSSEM DENGUIR
37|243TU232|FIORINO|DC|02/09/2022|AL BARAKA-LEAS|20/07/2027|DC|FIAT FIORINO|COURSIER - BECHRY ABDERAZZEK
38|398TU236|OPEL|DCD|04/04/2023|AL BARAKA-LEAS|20/02/2028|DCD|OPEL COMBO|MED NAJIB MAHFOUDH
39|588TU236|OPEL|DCD|04/04/2023|AL BARAKA-LEAS|20/02/2028|DCD|OPEL COMBO|MED FELFEL
40|7303TU242|MERCEDES|DCD|29/03/2024|LEASING WIFAK BANK|10/03/2029|DCD|MERCEDES C180|MOHAMED DENGUIR
41|9014TU242|SKODA|DC|25/03/2024|LEASING WIFAK BANK|25/03/2029|DC|SKODA OCTAVIA|TAHAR DENGUIR
42|9459TU240|TOYOTA|DCD|15/12/2023|ZITOUNA-LEAS|25/12/2028|DC|TOYOTA HIACE|RAOUF
43|À COMPLÉTER|TOYOTA|DCD|15/12/2023|ZITOUNA-LEAS|25/12/2028|DC|TOYOTA HIACE|RAMZI GHAZWANI
44|7613TU243|TOYOTA|DCD|21/05/2024|LEASING WIFAK BANK|10/05/2029|DC|TOYOTA HIACE|HOSNI
45|7612TU243|TOYOTA|DCD|21/05/2024|LEASING WIFAK BANK|10/05/2029|DC|TOYOTA HIACE|AMINE
46|811TU246|TOYOTA|TCM|20/08/2024|LEASING WIFAK BANK|20/07/2029|DC|TOYOTA HIACE|MEHREZ
47|4274TU254|BOXER|DCD|22/08/2025|HANNIBAL-LEAS|15/07/2029|DCD|PEUGEOT BOXER|AMARA - POSE
48|3619TU254|BOXER|DC|21/08/2025|HANNIBAL-LEAS|15/07/2029|DCD|PEUGEOT BOXER|HBIB RAJHI
49|596TU257|TOYOTA|DC|27/11/2025|HANNIBAL-LEAS|25/11/2029|DC|TOYOTA HIACE|MOHAMED BEN MBAREK
50|595TU257|TOYOTA|DC|27/11/2025|HANNIBAL-LEAS|25/11/2029|DC|TOYOTA HIACE|BILEL`
    .trim()
    .split("\n")
    .map((line) => {
      const [numero, immatriculation, type, societe, mise_en_circulation, titulaire, echeance_credit, affectation, reference, conducteur] = line.split("|");
      return {
        id: `v${numero}`,
        numero,
        immatriculation,
        type,
        societe,
        mise_en_circulation,
        titulaire,
        echeance_credit,
        affectation,
        reference,
        conducteur,
        statut: immatriculation === "À COMPLÉTER" ? "À compléter" : conducteur.includes("EN PANNE") ? "En panne" : "Actif",
      };
    }), */
  transactions: [],
  requests: [],
  mileage: [],
  anomalies: [],
  complaints: [],
  receipts: [],
  returnReceipts: [],
  drivers: [],
  fuelPrices: [],
};
const viewMeta: Record<View, [string, string]> = {
  dashboard: ["Vue d’ensemble", "Voici la situation de votre parc carburant."],
  reports: [
    "Rapports Direction",
    "Migration des cartes et suivi des nouvelles cartes.",
  ],
  cards: [
    "Cartes carburant",
    "Cycle complet, affectations, opposition et remplacement.",
  ],
  beneficiaries: [
    "Bénéficiaires",
    "Gérez les collaborateurs et leurs affectations.",
  ],
  vehicles: ["Véhicules", "Suivez tous les véhicules du parc."],
  drivers: ["Chauffeurs", "Gérez les chauffeurs par société et leurs véhicules."],
  fuelPrices: ["Prix carburants", "Historique des prix et ajustement automatique des plafonds."],
  transactions: [
    "Transactions Total",
    "Suivi des transactions Total, corrections et répartitions hors parc.",
  ],
  requests: ["Demandes", "Suivez les workflows et validations."],
  mileage: ["Kilométrage hebdomadaire", "Suivez les relevés, distances détectées et validations."],
  anomalies: ["Anomalies", "Analysez les alertes détectées."],
  complaints: ["Réclamations", "Échangez et suivez les réclamations entre Najib, Zin et la DG."],
  returns: ["Restitution des cartes", "Restituez les cartes arrivées à 100 % et conservez leur reçu comme preuve."],
  documents: ["Factures de rapprochement", "Générez et imprimez les factures hebdomadaires ou mensuelles pour le rapprochement avec Total."],
  settings: ["Paramètres", "Configurez l’application."],
};
const isDirection = (role: Role) =>
  role === "SUPER_ADMIN" || role === "DIRECTION_GENERAL";
const canCreate = (role: Role) =>
  role === "SUPER_ADMIN" ||
  role === "DIRECTION_GENERAL" ||
  role === "ZIN_FINANCE";
const canConfirm = (role: Role) =>
  role === "SUPER_ADMIN" ||
  role === "DIRECTION_GENERAL" ||
  role === "ZIN_FINANCE";
const canAssign = (role: Role) => role === "NAJIB_ASSIGNER";
const canManageCards = (role: Role) =>
  role === "SUPER_ADMIN" ||
  role === "DIRECTION_GENERAL" ||
  role === "ZIN_FINANCE";
const canManage = (role: Role) => role !== "NAJIB_ASSIGNER";
const canManageFleet = (role: Role) => canManage(role) || role === "NAJIB_ASSIGNER";

const roleWorkflows: Record<Role, { intro: string; steps: WorkflowStep[] }> = {
  NAJIB_ASSIGNER: {
    intro:
      "Vous gérez uniquement les cartes hors parc et répartissez les consommations Total entre les poseurs et les véhicules.",
    steps: [
      {
        number: "01",
        view: "transactions",
        title: "Consulter les transactions",
        description: "Repérez les montants importés par Zin pour vos cartes hors parc.",
      },
      {
        number: "02",
        view: "transactions",
        title: "Répartir la consommation",
        description: "Affectez le montant au poseur et à la matricule concernés.",
      },
      {
        number: "03",
        view: "dashboard",
        title: "Contrôler la répartition",
        description: "Vérifiez sous chaque carte le montant réparti et le solde restant.",
      },
      {
        number: "04",
        view: "requests",
        title: "Demander une nouvelle carte",
        description: "Envoyez une demande à Zin lorsque la carte en cours est terminée.",
      },
    ],
  },
  ZIN_FINANCE: {
    intro:
      "Vous alimentez la plateforme avec les données TotalEnergies et administrez le cycle de vie des cartes.",
    steps: [
      {
        number: "01",
        view: "transactions",
        title: "Importer le journal Total",
        description: "Importez le fichier Excel sans modifier les montants d’origine.",
      },
      {
        number: "02",
        view: "requests",
        title: "Traiter les demandes",
        description: "Acceptez ou refusez les demandes envoyées par Najib.",
      },
      {
        number: "03",
        view: "cards",
        title: "Gérer les cartes",
        description: "Créez, bloquez, remplacez ou réactivez une carte.",
      },
      {
        number: "04",
        view: "dashboard",
        title: "Suivre la consommation",
        description: "Contrôlez les plafonds, taux d’usage et répartitions hors parc.",
      },
    ],
  },
  DIRECTION_GENERAL: {
    intro:
      "Vous supervisez l’ensemble du processus, les consommations et les décisions financières.",
    steps: [
      {
        number: "01",
        view: "dashboard",
        title: "Voir la situation globale",
        description: "Consultez les cartes actives, consommations et alertes.",
      },
      {
        number: "02",
        view: "reports",
        title: "Analyser les rapports",
        description: "Suivez les plafonds, migrations et taux de consommation.",
      },
      {
        number: "03",
        view: "requests",
        title: "Suivre les demandes",
        description: "Contrôlez les demandes de Najib et les décisions de Zin.",
      },
      {
        number: "04",
        view: "cards",
        title: "Superviser le parc",
        description: "Accédez au détail et à l’historique de chaque carte.",
      },
    ],
  },
  SUPER_ADMIN: {
    intro:
      "Vous disposez d’une vue complète et de tous les droits d’administration de la plateforme.",
    steps: [
      {
        number: "01",
        view: "dashboard",
        title: "Superviser l’activité",
        description: "Vérifiez les indicateurs clés et les alertes du jour.",
      },
      {
        number: "02",
        view: "transactions",
        title: "Contrôler les imports",
        description: "Consultez les transactions originales TotalEnergies.",
      },
      {
        number: "03",
        view: "cards",
        title: "Administrer les cartes",
        description: "Gérez les cartes, affectations et remplacements.",
      },
      {
        number: "04",
        view: "reports",
        title: "Analyser les résultats",
        description: "Accédez aux rapports consolidés de la Direction.",
      },
    ],
  },
};

export default function Home() {
  const [token, setToken] = useState<string | null>(null),
    [user, setUser] = useState<User | null>(null),
    [view, setView] = useState<View>("dashboard"),
    [cards, setCards] = useState<Card[]>(initialCards),
    [safeCards,setSafeCards]=useState<Card[]>([]),
    [data, setData] = useState(seeds),
    [databaseSummary, setDatabaseSummary] = useState<Record<string, number> | null>(null),
    [directionData,setDirectionData]=useState<Record<string,unknown>|null>(null),
    [responsibles,setResponsibles]=useState<{id:string;name:string;email:string}[]>([]),
    [companies,setCompanies]=useState<{id:string;code:string;name:string}[]>([]),
    [selectedClientId,setSelectedClientId]=useState<string | null>(null),
    [showClientChooser,setShowClientChooser]=useState(false),
    [notifications, setNotifications] = useState<Notification[]>([]),
    [showNotifications, setShowNotifications] = useState(false),
    [search, setSearch] = useState(""),
    [modal, setModal] = useState<Modal>(null),
    [selected, setSelected] = useState<Card | null>(null),
    [allocationRow, setAllocationRow] = useState<Row | null>(null),
    [editingRow, setEditingRow] = useState<{
      view: "beneficiaries" | "vehicles";
      row: Row;
    } | null>(null),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [refreshTick,setRefreshTick]=useState(0),
    [loading, setLoading] = useState(false),
    [sessionSeconds, setSessionSeconds] = useState<number | null>(null),
    [extendingSession, setExtendingSession] = useState(false);
  // Hydrate the browser-only demo session after the client mounts.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const t = sessionStorage.getItem("delta_access"),
      u = sessionStorage.getItem("delta_user"),
      clientId = sessionStorage.getItem("delta_client"),
      saved = localStorage.getItem("delta_app_data_v1");
    // Retire définitivement les anciennes données fictives des versions démo.
    localStorage.removeItem("delta_demo_data_v6");
    if (t && t !== "demo" && u) {
      setToken(t);
      setUser(JSON.parse(u));
      setSelectedClientId(clientId);
      setShowClientChooser(!clientId);
    } else if (t === "demo") {
      sessionStorage.clear();
    }
    if (saved) {
      const x = JSON.parse(saved);
      setCards(x.cards ?? initialCards);
      const savedData = x.data ?? {};
      setData({
        ...seeds,
        ...savedData,
        // Le référentiel véhicules est toujours relu depuis PostgreSQL.
        // Une copie locale obsolète ne doit jamais réapparaître à l'écran.
        vehicles: [],
      });
      // Les notifications sont privées et toujours rechargées depuis l'API
      // pour l'utilisateur authentifié. Ne jamais hydrater celles d'une autre session.
      setNotifications([]);
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!token || !user) return;
    const expiresAt = (() => {
      try { return Number(JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp) * 1000; }
      catch { return 0; }
    })();
    if (!expiresAt) return;
    const check = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setSessionSeconds(remaining <= 120 ? remaining : null);
      if (remaining === 0) void logout("expired");
    };
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
  // Le minuteur doit être recréé uniquement lorsque le JWT ou son utilisateur change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user]);
  useEffect(() => {
    if (!token || !user) return;
    let cancelled = false;
    let activeAccessToken = token;
    const loadRemote = (accessToken: string) => {
      const headers = { Authorization: `Bearer ${accessToken}` };
      return Promise.all([
      fetch(`${API}/cards`, { headers, cache: "no-store" }),
      fetch(`${API}/requests`, { headers, cache: "no-store" }),
      fetch(`${API}/notifications`, { headers, cache: "no-store" }),
      fetch(`${API}/transactions`, { headers, cache: "no-store" }),
      fetch(`${API}/dashboard/summary`, { headers, cache: "no-store" }),
      canManage(user.role) ? fetch(`${API}/dashboard/anomalies`, { headers, cache: "no-store" }) : Promise.resolve(null),
      fetch(`${API}/vehicles`, { headers, cache: "no-store" }),
      fetch(`${API}/mileage`, { headers, cache: "no-store" }),
      fetch(`${API}/drivers`, { headers, cache: "no-store" }),
      fetch(`${API}/fuel-prices`, { headers, cache: "no-store" }),
      fetch(`${API}/cards/responsibles`,{headers,cache:"no-store"}),
      fetch(`${API}/cards/companies`,{headers,cache:"no-store"}),
      user.role==="NAJIB_ASSIGNER"?fetch(`${API}/cards/safe-inventory`,{headers,cache:"no-store"}):Promise.resolve(null),
      fetch(`${API}/complaints`,{headers,cache:"no-store"}),
      fetch(`${API}/documents/receipts`,{headers,cache:"no-store"}),
      fetch(`${API}/documents/return-receipts`,{headers,cache:"no-store"}),
      ]);
    };
    const renewSession = async () => {
      const refreshToken = sessionStorage.getItem("delta_refresh");
      if (!refreshToken) throw new Error("session expirée");
      const response = await fetch(`${API}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) throw new Error("session expirée");
      const payload = await response.json();
      activeAccessToken = String(payload.accessToken);
      sessionStorage.setItem("delta_access", activeAccessToken);
      sessionStorage.setItem("delta_refresh", String(payload.refreshToken));
      if (!cancelled) setToken(activeAccessToken);
      return activeAccessToken;
    };
    const refreshRemote = async () => {
      let responses = await loadRemote(activeAccessToken);
      if (responses.some((response) => response?.status === 401)) {
        const renewedToken = await renewSession();
        responses = await loadRemote(renewedToken);
      }
      return responses;
    };
    refreshRemote()
      .then(async ([cardResponse, requestResponse, notificationResponse,transactionResponse,summaryResponse,reviewsResponse,vehiclesResponse,mileageResponse,driversResponse,fuelPricesResponse,responsiblesResponse,companiesResponse,safeResponse,complaintsResponse,receiptsResponse,returnReceiptsResponse]) => {
        if (cancelled) return;
        // Management reference data must remain usable even if an unrelated
        // dashboard endpoint is temporarily unavailable.
        if(responsiblesResponse?.ok)setResponsibles(await responsiblesResponse.json());
        if(companiesResponse?.ok)setCompanies(await companiesResponse.json());
        if(safeResponse?.ok)setSafeCards(await safeResponse.json());
        const requiredResponses=[
          ["cartes",cardResponse],["demandes",requestResponse],["notifications",notificationResponse],
          ["transactions",transactionResponse],["tableau de bord",summaryResponse],["véhicules",vehiclesResponse],
          ["kilométrages",mileageResponse],["chauffeurs",driversResponse],["prix carburant",fuelPricesResponse],
          ["réclamations",complaintsResponse],["reçus",receiptsResponse],["reçus de restitution",returnReceiptsResponse],
        ] as const;
        const failed=requiredResponses.find(([,response])=>!response.ok);
        if(failed) throw new Error(`${failed[0]} (${failed[1].status})`);
        const cardPayload = await cardResponse.json();
        const requestPayload = await requestResponse.json();
        const notificationPayload = await notificationResponse.json();
        const transactionPayload = await transactionResponse.json();
        const summaryPayload = await summaryResponse.json();
        const reviewsPayload = reviewsResponse?.ok ? await reviewsResponse.json() : [];
        const vehiclesPayload=await vehiclesResponse.json();
        const mileagePayload=await mileageResponse.json();
        const driversPayload=await driversResponse.json(); const fuelPricesPayload=await fuelPricesResponse.json();
        const complaintsPayload=await complaintsResponse.json();const receiptsPayload=await receiptsResponse.json();const returnReceiptsPayload=await returnReceiptsResponse.json();
        setCards(cardPayload.items ?? cardPayload);
        setNotifications((notificationPayload.items ?? notificationPayload).map(
          (row: Record<string, unknown>) => toNotification(row, user.role),
        ));
        setData((current) => ({
          ...current,
          requests: (requestPayload.items ?? requestPayload).map(toRequestRow),
          transactions: (transactionPayload.items ?? transactionPayload).map((row:Record<string,unknown>) => {const allocations=Array.isArray(row.allocations)?row.allocations as Record<string,unknown>[]:[];return { id:String(row.id),reviewId:String(row.reviewId??""),date:new Date(String(row.date)).toLocaleString("fr-MA"),carte:String(row.card),beneficiaire:String(row.beneficiary??"—"),vehicule:String(row.vehicle??"—"),station:String(row.station??"—"),produit:String(row.product??"—"),litres:Number(row.liters),montant:Number(row.amount),prixApplique:row.appliedPrice==null?"—":Number(row.appliedPrice),montantTheorique:row.expectedAmount==null?"—":Number(row.expectedAmount),ecartFacturation:row.billingDifference==null?"—":Number(row.billingDifference),controleFacturation:String(row.billingStatus??"PRICE_UNAVAILABLE"),montantReparti:Number(row.allocatedAmount??0),repartitionEnAttente:String(row.pendingAllocationId??""),repartition:allocations.map(item=>`${String(item.beneficiary)} — ${String(item.vehicle)} — ${Number(item.amount).toFixed(3)} DT${item.mileage?` — ${Number(item.mileage)} km`:""}`).join(" | "),observation:row.observation?`${String(row.observation)} — ${String(row.observationBy??"—")}`:"—",statut:row.reviewStatus==="PENDING"?(row.reviewIssue==="MISSING_BENEFICIARY"?"Bénéficiaire à identifier":"Véhicule inconnu à valider"):"Importée Total",fichier:String(row.file??"—") }}),
          anomalies: (reviewsPayload.items ?? reviewsPayload).map((row:Record<string,unknown>) => {const reviewLabels:Record<string,string>={MISSING_BENEFICIARY:"Bénéficiaire manquant",UNKNOWN_CARD:"Carte absente de la base",UNAVAILABLE_CARD:"Carte indisponible",UNKNOWN_VEHICLE:"Véhicule absent de la base",UNAVAILABLE_VEHICLE:"Véhicule indisponible"};return { id:String(row.id),kind:String(row.kind??"REVIEW"),date:new Date(String(row.date)).toLocaleString("fr-MA"),type:String(row.kind)==="REVIEW"?(reviewLabels[String(row.type)]??"Transaction à vérifier"):String(row.description??row.type),carte:String(row.card??"—"),beneficiaire:"—",vehicule:String(row.vehicle??"—"),station:String(row.station??"—"),produit:String(row.product??"—"),litres:Number(row.liters??0),montant:Number(row.amount??0),gravite:String(row.severity)==="CRITICAL"?"Critique":String(row.severity)==="WARNING"?"Moyenne":String(row.severity)==="INFO"?"Information":"Haute",statut:String(row.kind)==="REVIEW"?"À vérifier":String(row.status)==="IN_REVIEW"?"En cours":"Ouverte" }}),
          vehicles:(vehiclesPayload.items??vehiclesPayload).map((row:Record<string,unknown>,index:number)=>({id:String(row.id),companyId:String(row.companyId??""),numero:Number(row.fleetNumber??0)||index+1,immatriculation:Boolean(row.registrationMissing)?"Sans matricule":String(row.registration),sansMatricule:Boolean(row.registrationMissing),type:String(row.vehicleType??row.model??"À compléter"),societe:String(row.company??"—"),mise_en_circulation:row.firstRegistrationDate?new Date(String(row.firstRegistrationDate)).toLocaleDateString("fr-FR"):"À compléter",reference:[row.brand,row.model].filter(Boolean).join(" "),conducteur:String(row.driver??row.cardHolder??"—"),titulaire:String(row.cardHolder??row.driver??"—"),carte:String(row.cardNumber??"—"),garde:String(row.custody)==="IN_SAFE"?"En coffre · non distribuée":"Distribuée / active",observation:String(row.notes??"—"),kilometrage:Number(row.lastMileage??0),statut:Boolean(row.active)?"Actif":"Inactif"})),
          mileage:(mileagePayload.items??mileagePayload).map((row:Record<string,unknown>)=>({id:String(row.id),semaine:frenchDate(row.week),vehicule:String(row.vehicle),detailsVehicule:[row.brand,row.model,row.vehicleType].filter(Boolean).join(" · ")||"Informations à compléter",miseEnCirculation:frenchDate(row.firstRegistrationDate),societe:String(row.company),responsable:String(row.responsible??"—"),precedent:Number(row.previousMileage??0),distanceDetectee:Number(row.detectedDistance??0),litresPeriode:Number(row.periodLiters??0),consommation100km:row.litersPer100Km==null?"—":Number(row.litersPer100Km),reference100km:row.referenceLitersPer100Km==null?"—":Number(row.referenceLitersPer100Km),distanceEstimee:row.estimatedDistance==null?"—":Number(row.estimatedDistance),attendu:Number(row.estimatedMileage??row.expectedMileage??0),rapprochement:String(row.reconciliationMessage??"—"),kilometrage:Number(row.mileage),anomalie:Boolean(row.anomaly)?"Oui":"Non",statut:String(row.status)==="PENDING"?"EN_ATTENTE_ZIN":String(row.status)==="VALIDATED"?"VALIDEE_ZIN":"REFUSEE_ZIN",validateur:String(row.reviewer??"—"),detailsTransactions:JSON.stringify(row.transactions??[])})),
          drivers:(driversPayload.items??driversPayload).map((row:Record<string,unknown>)=>({id:String(row.id),companyId:String(row.companyId??""),nomComplet:String(row.fullName??"—"),numeroClient:String(row.customerNumber??"—"),nomClient:String(row.customerName??"—"),numeroChauffeur:String(row.driverNumber??"—"),prenom:String(row.firstName??"—"),nom:String(row.lastName??row.fullName??"—"),codeChauffeur:String(row.driverCode??"—"),vehicules:Array.isArray(row.vehicles)?(row.vehicles as {registration:string}[]).map(item=>item.registration).join(", "):"—",statut:Boolean(row.active)?"Actif":"Inactif"})),
          fuelPrices:(fuelPricesPayload.items??fuelPricesPayload).map((row:Record<string,unknown>)=>({id:String(row.id),societe:String(row.company),produit:String(row.product),ancienPrix:Number(row.oldPrice),nouveauPrix:Number(row.newPrice),variation:`${Number(row.variationPercent).toFixed(2)} %`,date:new Date(String(row.effectiveDate)).toLocaleDateString("fr-FR"),auteur:String(row.createdBy??"—"),source:String(row.source)==="OFFICIAL_TUNISIA"?"Ministère tunisien":String(row.source)==="TOTAL_SUPPLIER"?"Tarif fournisseur Total":"Saisie manuelle"})),
          complaints:(complaintsPayload.items??complaintsPayload).map((row:Record<string,unknown>)=>({id:String(row.id),numero:String(row.number),objet:String(row.subject),description:String(row.description),priorite:String(row.priority),statut:String(row.status),destinataire:String(row.targetRole),createur:String(row.creator),date:new Date(String(row.createdAt)).toLocaleString("fr-FR"),resolution:String(row.resolution??"—"),messages:JSON.stringify(row.messages??[])})),
          receipts:(receiptsPayload.items??receiptsPayload).map((row:Record<string,unknown>)=>({id:String(row.id),numero:String(row.receiptNumber),carte:String(row.card),beneficiaire:String(row.beneficiary),vehicule:String(row.vehicle),distribueA:String(row.distributedTo),statut:String(row.status),zin:String(row.zinApprovedBy??"En attente"),dg:String(row.dgApprovedBy??"En attente"),date:String(row.issuedAt?new Date(String(row.issuedAt)).toLocaleString("fr-FR"):"—")})),
          returnReceipts:(returnReceiptsPayload.items??returnReceiptsPayload).map((row:Record<string,unknown>)=>({id:String(row.id),numero:String(row.receiptNumber),carte:String(row.card),restituePar:String(row.returnedBy),recuPar:String(row.receivedBy),dg:String(row.dgApprovedBy),taux:Number(row.consumptionRate),plafond:Number(row.monthlyLimit),plafondActuel:Number(row.currentLimit),consomme:Number(row.consumedAmount),litres:Number(row.consumedLiters),transactions:Number(row.transactionCount),restaureeLe:row.restoredAt?new Date(String(row.restoredAt)).toLocaleString("fr-FR"):"",restaureePar:String(row.restoredBy??""),statutCarte:String(row.cardStatus??""),moisCle:String(row.consumptionMonth).slice(0,7),mois:new Date(String(row.consumptionMonth)).toLocaleDateString("fr-FR",{month:"long",year:"numeric"}),date:new Date(String(row.returnedAt)).toLocaleDateString("fr-FR"),heure:new Date(String(row.returnedAt)).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit",second:"2-digit"})})),
        }));
        setDatabaseSummary(summaryPayload);
        setError("");
      })
      .catch((reason) => {
        if (cancelled) return;
        const sessionExpired = reason instanceof Error && reason.message === "session expirée";
        if (sessionExpired) {
          sessionStorage.clear();
          setToken(null);
          setUser(null);
          setError("Votre session a expiré. Reconnectez-vous pour continuer en toute sécurité.");
          return;
        }
        setError(`Synchronisation API momentanément indisponible${reason instanceof Error ? ` : ${reason.message}` : ""}. Nouvelle tentative automatique en cours.`);
      });
    const timer = window.setInterval(() => setRefreshTick((current) => current + 1), 30000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [token, user, refreshTick]);
  useEffect(()=>{
    if(!token||!user||user.role==="NAJIB_ASSIGNER")return;
    const headers={Authorization:`Bearer ${token}`};
    Promise.all([fetch(`${API}/dashboard/direction`,{headers,cache:"no-store"}),fetch(`${API}/transactions/imports`,{headers,cache:"no-store"})])
      .then(async([directionResponse,importsResponse])=>{
        if(directionResponse.ok)setDirectionData(await directionResponse.json());
        if(importsResponse.ok){const payload=await importsResponse.json();setData(current=>({...current,importHistory:(payload.items??payload).map((row:Record<string,unknown>)=>({
          id:String(row.id),date:new Date(String(row.importedAt)).toLocaleString("fr-FR"),fichier:String(row.filename),auteur:String(row.importedBy??"—"),
          lignes:Number(row.totalRows),importees:Number(row.importedRows),doublons:Number(row.duplicateRows),controle:Number(row.rejectedRows),actives:Number(row.activeTransactions),statut:String(row.status),motif:String(row.revertReason??"—")
        }))}));}
      }).catch(()=>undefined);
  },[token,user,refreshTick]);
  const persist = (
    nextCards = cards,
    nextData = data,
  ) =>
    localStorage.setItem(
      "delta_app_data_v1",
      JSON.stringify({
        cards: nextCards,
        data: nextData,
      }),
    );
  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 3000);
  };
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const f = new FormData(e.currentTarget),
      email = String(f.get("email")).toLowerCase(),
      password = String(f.get("password"));
    try {
      const r = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) throw Error();
      const x = await r.json();
      sessionStorage.setItem("delta_access", x.accessToken);
      sessionStorage.setItem("delta_refresh", x.refreshToken);
      sessionStorage.setItem("delta_user", JSON.stringify(x.user));
      setNotifications([]);
      setToken(x.accessToken);
      setUser(x.user);
      setSelectedClientId(null);
      setShowClientChooser(true);
    } catch {
      setError("Connexion à l’API impossible ou identifiants invalides");
    } finally {
      setLoading(false);
    }
  }
  async function continueSession() {
    const refreshToken = sessionStorage.getItem("delta_refresh");
    if (!refreshToken) return logout("expired");
    setExtendingSession(true);
    try {
      const response = await fetch(`${API}/auth/refresh`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({refreshToken}) });
      if (!response.ok) throw new Error();
      const payload = await response.json();
      sessionStorage.setItem("delta_access", String(payload.accessToken));
      sessionStorage.setItem("delta_refresh", String(payload.refreshToken));
      setToken(String(payload.accessToken));
      setSessionSeconds(null);
      notify("Session prolongée en toute sécurité");
    } catch { await logout("expired"); }
    finally { setExtendingSession(false); }
  }
  async function logout(reason?: "expired") {
    const refreshToken = sessionStorage.getItem("delta_refresh");
    if (token !== "demo" && refreshToken)
      await fetch(`${API}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => undefined);
    sessionStorage.clear();
    setToken(null);
    setUser(null);
    setSelectedClientId(null);
    setShowClientChooser(false);
    setNotifications([]);
    setShowNotifications(false);
    setSessionSeconds(null);
    if (reason === "expired") setError("Votre session sécurisée a expiré. Veuillez vous reconnecter.");
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user) return;
    const f = new FormData(e.currentTarget),
      id = crypto.randomUUID(),
      today = new Date().toLocaleDateString("fr-MA");
    if (modal === "card") {
      if (!canCreate(user.role))
        return notify("Création réservée à Zin, DG et Superadmin");
      const number = String(f.get("number")).trim();
      const beneficiary = String(f.get("beneficiary") || "").trim() || null;
      const registration = String(f.get("registration") || "").trim() || null;
      const department = String(f.get("department") || "").trim() || null;
      const vehicleModel = String(f.get("vehicleModel") || "").trim() || null;
      if(!token)return notify("Session distante expirée");
      let remote:Record<string,unknown>;
      try{const response=await fetch(`${API}/cards`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({cardNumber:number,monthlyLimit:Number(f.get("limit")),cardCategory:String(f.get("cardCategory")||"PERSONALIZED"),responsibleUserId:f.get("responsibleUserId")?String(f.get("responsibleUserId")):undefined,companyId:f.get("companyId")?String(f.get("companyId")):undefined})});if(!response.ok)throw new Error(await response.text());remote=await response.json();}catch(error){return notify(error instanceof Error?error.message:"La carte n’a pas été créée dans la base");}
      const next: Card[] = [
        {
          id:String(remote.id),
          masked_card_number: number,
          company_code: companies.find(item=>item.id===String(f.get("companyId")))?.code??"DELTA",
          beneficiary,
          department,
          registration,
          vehicle_model: vehicleModel,
          monthly_limit: Number(f.get("limit")),
          status: beneficiary && registration ? "ACTIVE" : "TO_ASSIGN",
          finance_status: "CONFIRMED",
          created_at: today,
          updated_at: today,
          card_category: String(f.get("cardCategory") || "PERSONALIZED") as Card["card_category"],
          responsible_user_id:String(f.get("responsibleUserId")||"")||undefined,
        },
        ...cards,
      ];
      setCards(next);
      persist(next, data);
      notify(
        beneficiary
          ? "Carte Zin créée : bénéficiaire et véhicule détectés automatiquement"
          : "Carte créée — elle est prête à être affectée",
      );
    } else if (modal === "cardAction" && selected) {
      const action = String(f.get("action"));
      const actionResponsibleUserId=String(f.get("actionResponsibleUserId")||"");
      const actionObservation=String(f.get("actionObservation")||f.get("reason")||"").trim();
      if(!actionResponsibleUserId)return notify("Sélectionnez obligatoirement le responsable de cette action");
      const recordAction=async()=>{
        if(!token)throw new Error("Session distante expirée");
        const response=await fetch(`${API}/cards/${selected.id}/action-responsibility`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({actionType:action,responsibleUserId:actionResponsibleUserId,observation:actionObservation||undefined})});
        if(!response.ok)throw new Error("Le responsable de l’action n’a pas été enregistré");
      };
      let change: Partial<Card> = { updated_at: today };
      if(action==="editDetails"){
        if(!canManage(user.role)||!token)return notify("Modification réservée à Zin et à la Direction");
        const cardNumber=String(f.get("cardNumber")||"").trim();
        const beneficiary=String(f.get("editBeneficiary")||"").trim();
        const monthlyLimit=Number(f.get("monthlyLimit"));
        if(!cardNumber||!beneficiary||!Number.isFinite(monthlyLimit)||monthlyLimit<0)return notify("Vérifiez le numéro, le bénéficiaire et le plafond");
        try{
          const response=await fetch(`${API}/cards/${selected.id}`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({cardNumber,beneficiary,monthlyLimit})});
          const body=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(String(body.message??"Modification impossible"));
          change={...change,masked_card_number:cardNumber,beneficiary,monthly_limit:monthlyLimit};
        }catch(error){return notify(error instanceof Error?error.message:"La carte n’a pas été modifiée");}
      } else if (action === "assign") {
        if (!canAssign(user.role))
          return notify("Affectation réservée à Najib");
        if (selected.activation_locked && selected.old_card_id) {
          const previous = cards.find((card) => card.id === selected.old_card_id);
          if (previous && consumptionRate(previous) < 100)
            return notify(`Carte verrouillée : terminez d’abord l’ancienne carte ${previous.masked_card_number} (${consumptionRate(previous)} %)`);
        }
        const vehicleId=String(f.get("vehicleId")||"");const vehicle=data.vehicles.find(row=>row.id===vehicleId);if(!vehicle)return notify("Sélectionnez un véhicule");
        if(!token)return notify("Session distante expirée");try{const response=await fetch(`${API}/cards/${selected.id}/assignment`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({beneficiary:String(f.get("beneficiary")),vehicleId})});if(!response.ok)throw new Error(await response.text());}catch{return notify("L’affectation n’a pas été enregistrée");}
        change = {
          ...change,
          beneficiary: String(f.get("beneficiary")),
          registration: String(vehicle.immatriculation),
          status: "ASSIGNED",
          finance_status: "PENDING",
        };
      } else if (action === "distributed")
        change = {
          ...change,
          status: "DISTRIBUTED",
          finance_status: "PENDING",
        };
      else if (["LOST", "STOLEN"].includes(action))
        change = {
          ...change,
          status: action as CardStatus,
          finance_status: "PENDING",
          opposition_reason: String(
            f.get("reason") ||
              (action === "LOST" ? "Carte perdue" : "Carte volée"),
          ),
        };
      else if (action === "oppose")
        change = {
          ...change,
          status: "OPPOSED",
          opposition_reason: String(f.get("reason") || "Opposition confirmée"),
        };
      else if (action === "confirm")
        change = {
          ...change,
          finance_status: "CONFIRMED",
          status: selected.status === "ASSIGNED" ? "ACTIVE" : selected.status,
        };
      else if (action === "reject")
        change = { ...change, finance_status: "REJECTED" };
      else if (action === "block") {
        if (!canManage(user.role))
          return notify("Blocage réservé à Zin et à la Direction");
        change = { ...change, status: "SUSPENDED" };
      } else if (action === "unblock") {
        if (!canManage(user.role))
          return notify("Déblocage réservé à Zin et à la Direction");
        change = { ...change, status: "ACTIVE" };
      } else if(action==="responsible") {
        if(!canManage(user.role)||!token)return notify("Transfert réservé à Zin, Mahdi et à la DG");
        const responsibleUserId=String(f.get("responsibleUserId")||"");if(!responsibleUserId)return notify("Sélectionnez un responsable");
        try{const response=await fetch(`${API}/cards/${selected.id}/responsible`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({responsibleUserId})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(String(body.message??"Transfert impossible"));change={...change,responsible_user_id:responsibleUserId,responsible_name:String(body.responsibleName??responsibles.find(item=>item.id===responsibleUserId)?.name??"")};}catch(error){return notify(error instanceof Error?error.message:"Le transfert n’a pas été enregistré");}
      } else if (action === "replace") {
        if (!canManage(user.role))
          return notify("Remplacement réservé à Zin et à la Direction");
        const replacementId = String(f.get("replacementId"));
        const replacement = cards.find((c) => c.id === replacementId);
        if (!replacement) return notify("Sélectionnez une carte remplaçante");
        const reason = String(f.get("reason") || "Remplacement");
        if (!token) return notify("Session distante expirée : reconnectez-vous");
        try {
          const response = await fetch(`${API}/cards/${selected.id}/replace`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ replacementCardId: replacement.id, reason }),
          });
          if (!response.ok) throw new Error(await response.text());
        } catch {
          return notify("Échec du remplacement distant : aucune carte n’a été modifiée");
        }
        try{await recordAction();}catch(error){return notify(error instanceof Error?error.message:"Traçabilité non enregistrée");}
        const inherited = {
          beneficiary: selected.beneficiary,
          department: selected.department,
          registration: selected.registration,
          vehicle_model: selected.vehicle_model,
          old_card_id: selected.id,
          status: "ACTIVE" as CardStatus,
          finance_status: "CONFIRMED" as FinanceStatus,
          updated_at: today,
        };
        const next = cards.map((c) =>
          c.id === selected.id
            ? {
                ...c,
                status: "REPLACED" as CardStatus,
                replacement_card_id: replacement.id,
                opposition_reason: reason,
                updated_at: today,
              }
            : c.id === replacement.id
              ? { ...c, ...inherited }
              : c,
        );
        setCards(next);
        persist(next, data);
        notify(
          `Carte ${replacement.masked_card_number} liée à ${selected.masked_card_number} — historique conservé`,
        );
        setModal(null);
        setSelected(null);
        return;
      } else if (action === "delete") {
        if (!isDirection(user.role))
          return notify("Suppression non autorisée");
        if (
          ["LOST", "STOLEN", "OPPOSED"].includes(selected.status) &&
          !selected.replacement_card_id
        )
          return notify(
            "Créez et liez d’abord la carte remplaçante pour conserver l’historique",
          );
        if (!token) return notify("Session distante expirée : reconnectez-vous");
        try {
          const response = await fetch(`${API}/cards/${selected.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!response.ok) throw new Error(await response.text());
        } catch {
          return notify("Échec de l’archivage distant : la carte reste disponible");
        }
        try{await recordAction();}catch(error){return notify(error instanceof Error?error.message:"Traçabilité non enregistrée");}
        const next = cards.filter((c) => c.id !== selected.id);
        setCards(next);
        persist(next, data);
        notify(
          "Carte archivée — transactions et chaîne de remplacement conservées",
        );
        setModal(null);
        setSelected(null);
        return;
      }
      if (["block", "unblock", "oppose", "LOST", "STOLEN", "distributed", "confirm", "reject"].includes(action)) {
        if (!token) return notify("Session distante expirée : reconnectez-vous");
        try {
          const response = await fetch(`${API}/cards/${selected.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ status: change.status, financeStatus: change.finance_status }),
          });
          if (!response.ok) throw new Error(await response.text());
        } catch {
          return notify("Échec de l’action distante : la carte n’a pas été modifiée");
        }
      }
      try{await recordAction();}catch(error){return notify(error instanceof Error?error.message:"Traçabilité non enregistrée");}
      const next = cards.map((c) =>
        c.id === selected.id ? { ...c, ...change, latest_action_type:action, latest_action_responsible:responsibles.find(item=>item.id===actionResponsibleUserId)?.name??"Responsable" } : c,
      );
      if (action === "confirm" && selected.beneficiary) {
        const confirmed = next.find((c) => c.id === selected.id)!;
        const beneficiaryIndex = data.beneficiaries.findIndex(
          (row) =>
            String(row.nom).toLowerCase() ===
            String(confirmed.beneficiary).toLowerCase(),
        );
        const beneficiaries =
          beneficiaryIndex >= 0
            ? data.beneficiaries.map((row, index) =>
                index === beneficiaryIndex
                  ? {
                      ...row,
                      service: confirmed.department ?? row.service,
                      carte: confirmed.masked_card_number,
                      vehicule: confirmed.registration ?? "—",
                      statut: "Actif",
                    }
                  : row,
              )
            : [
                {
                  id: crypto.randomUUID(),
                  nom: String(confirmed.beneficiary),
                  service: confirmed.department ?? "À compléter",
                  carte: confirmed.masked_card_number,
                  vehicule: confirmed.registration ?? "—",
                  statut: "Actif",
                },
                ...data.beneficiaries,
              ];
        const vehicleIndex = data.vehicles.findIndex(
          (row) =>
            String(row.immatriculation).toLowerCase() ===
            String(confirmed.registration).toLowerCase(),
        );
        const vehicles = confirmed.registration
          ? vehicleIndex >= 0
            ? data.vehicles.map((row, index) =>
                index === vehicleIndex
                  ? {
                      ...row,
                      beneficiaire: confirmed.beneficiary ?? "—",
                      carte: confirmed.masked_card_number,
                      statut: "Actif",
                    }
                  : row,
              )
            : [
                {
                  id: crypto.randomUUID(),
                  immatriculation: confirmed.registration,
                  marque: confirmed.vehicle_model ?? "À compléter",
                  beneficiaire: String(confirmed.beneficiary),
                  carte: confirmed.masked_card_number,
                  statut: "Actif",
                },
                ...data.vehicles,
              ]
          : data.vehicles;
        const synchronized = { ...data, beneficiaries, vehicles };
        setCards(next);
        setData(synchronized);
        persist(next, synchronized);
        notify(
          "Affectation validée et synchronisée dans Bénéficiaires et Véhicules",
        );
      } else {
        setCards(next);
        persist(next, data);
        notify("Carte mise à jour");
      }
    } else if(modal==="mileage") {
      if(!["NAJIB_ASSIGNER","ZIN_FINANCE"].includes(user.role))return notify("Saisie réservée à Najib et Zin");
      if(!token)return notify("Session distante expirée");
      try{const response=await fetch(`${API}/mileage`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({vehicleId:String(f.get("vehicleId")),mileage:Number(f.get("mileage")),note:String(f.get("note")??"")})});if(!response.ok)throw new Error(await response.text());const created=await response.json();setRefreshTick(value=>value+1);notify(created.anomaly?`Anomalie détectée : kilométrage attendu ${created.expectedMileage}`:user.role==="ZIN_FINANCE"?"Kilométrage enregistré et validé par Zin":"Relevé envoyé à Zin et à la DG");}catch(error){return notify(error instanceof Error?error.message:"Échec du relevé kilométrique");}
    } else if(modal==="driver"||modal==="fuelPrice"){
      if((modal==="driver"?!canManageFleet(user.role):!canManage(user.role))||!token)return notify(modal==="driver"?"Gestion des chauffeurs non autorisée":"Action réservée à Zin et à la DG");
      const endpoint=modal==="driver"?"drivers":"fuel-prices";
      const body=modal==="driver"?{companyId:String(f.get("companyId")),customerNumber:String(f.get("customerNumber")),customerName:String(f.get("customerName")),driverNumber:String(f.get("driverNumber")),firstName:String(f.get("firstName")),lastName:String(f.get("lastName")),driverCode:String(f.get("driverCode"))}:{companyId:String(f.get("companyId")),product:String(f.get("product")),newPrice:Number(f.get("newPrice")),effectiveDate:String(f.get("effectiveDate")||"")||undefined};
      try{const response=await fetch(`${API}/${endpoint}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(body)});if(!response.ok)throw new Error(await response.text());notify(modal==="driver"?"Chauffeur ajouté":"Prix enregistré et plafonds ajustés");}catch(error){return notify(error instanceof Error?error.message:"Enregistrement impossible");}
    } else if (modal && ["beneficiary", "vehicle", "request"].includes(modal)) {
      if (modal === "request" && user.role !== "NAJIB_ASSIGNER")
        return notify(
          "Les demandes de carte passent obligatoirement par Najib",
        );
      if (modal !== "request" && modal !== "vehicle" && !canManage(user.role))
        return notify("Action réservée à Zin et à la Direction Générale");
      if (modal === "vehicle" && !canManageFleet(user.role))
        return notify("Gestion des véhicules non autorisée");
      const key =
        modal === "beneficiary"
          ? "beneficiaries"
          : modal === "vehicle"
            ? "vehicles"
            : "requests";
      const row = Object.fromEntries(f.entries()) as Row;
      row.id = id;
      if (modal === "vehicle") {
        const registration = String(row.immatriculation ?? "").trim().toUpperCase();
        if (!registration) return notify("La matricule est obligatoire");
        if (!String(row.type ?? "").trim()) return notify("Le type de véhicule est obligatoire");
        if (!String(row.societe ?? "").trim()) return notify("La société est obligatoire");
        if (data.vehicles.some((vehicle) => String(vehicle.immatriculation).trim().toUpperCase() === registration))
          return notify("Cette matricule existe déjà");
        row.immatriculation = registration;
        row.numero = String(data.vehicles.length + 1);
        row.carte = "—";
        const company=companies.find(item=>item.code.toLowerCase()===String(row.societe??"").trim().toLowerCase());
        if(!company)return notify("Société inconnue : utilisez un code disponible (DC, DCD, TCM ou IKIT)");
        if(!token)return notify("Session distante expirée");
        try{const response=await fetch(`${API}/vehicles`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({companyId:company.id,registration,brand:String(row.reference??""),model:String(row.type??"")})});if(!response.ok)throw new Error(await response.text());const created=await response.json();row.id=String(created.id);row.societe=company.code;}catch(error){return notify(error instanceof Error?error.message:"Le véhicule n’a pas été enregistré dans PostgreSQL");}
      }
      if (modal === "request") {
        row.numero = `D-${new Date().getFullYear()}-${String(data.requests.length + 1).padStart(3, "0")}`;
        row.type = String(row.typeDemande) === "LIMIT_CHANGE" ? "Augmentation de plafond" : String(row.typeDemande)==="CARD_FUNDING"?"Alimentation de carte":String(row.typeDemande)==="CUSTODY_CHANGE"?(String(row.etatCarte)==="SAFE"?"Mise en coffre":"Distribution de carte"):"Nouvelle carte";
        if (row.carteId) row.carte = cards.find((item) => item.id === String(row.carteId))?.masked_card_number ?? "—";
        row.demandeur = user.name;
        row.date = today;
        row.statut = "EN_ATTENTE_ZIN";
        if (!token) return notify("Session distante expirée : reconnectez-vous");
        try {
          const response = await fetch(`${API}/requests`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              requestType: String(row.typeDemande || "NEW_CARD"),
              requestedCardStatus: row.typeDemande === "CUSTODY_CHANGE" ? String(row.etatCarte) : undefined,
              fuelCardId: row.carteId ? String(row.carteId) : undefined,
              sourceCardId: row.carteSourceId ? String(row.carteSourceId) : undefined,
              beneficiary: String(row.beneficiaire),
              department: String(row.departement),
              vehicle: String(row.voiture),
              requestedLimit: parseNumeric(row.plafond),
              reason: String(row.motif),
              responsibleUserId: String(row.responsableAction),
            }),
          });
          if (!response.ok) throw new Error(await response.text());
          const created = await response.json();
          row.id = created.id;
          row.numero = created.requestNumber;
        } catch (error) {
          const message=error instanceof Error?error.message:"";
          try{const parsed=JSON.parse(message);return notify(String(parsed.message??message));}catch{return notify(message||"Échec de l’envoi distant : la demande n’a pas été enregistrée");}
        }
      }
      const next = { ...data, [key]: [row, ...data[key]] };
      setData(next);
      if (modal === "request") {
        const created: Notification[] = (
          ["ZIN_FINANCE", "DIRECTION_GENERAL", "SUPER_ADMIN"] as Role[]
        ).map((target) => ({
          id: crypto.randomUUID(),
          target,
          title: String(row.typeDemande) === "LIMIT_CHANGE" ? "Demande d’augmentation de plafond" : String(row.typeDemande)==="CARD_FUNDING"?"Demande d’alimentation de carte":String(row.typeDemande)==="CUSTODY_CHANGE"?"Demande coffre / distribution":"Nouvelle demande de carte",
          message: `${row.numero} — ${row.beneficiaire}`,
          view: "requests",
          read: false,
          createdAt: new Date().toLocaleString("fr-MA"),
        }));
        const nextNotifications = [...created, ...notifications];
        setNotifications(nextNotifications);
        setNotifications(nextNotifications);
      } else persist(cards, next);
      notify(
        modal === "request"
          ? "Demande envoyée à Zin Finance et à la Direction"
          : "Enregistrement ajouté",
      );
    } else if (modal === "import") {
      if (!canManage(user.role))
        return notify("Najib peut seulement consulter les transactions");
      const file = f.get("file");
      if (!(file instanceof File) || !file.name.match(/\.(xlsx?|csv)$/i))
        return notify("Sélectionnez un fichier Total Excel ou CSV (.xlsx, .xls, .csv)");
      try {
        const workbook = XLSX.read(await file.arrayBuffer(), {
          type: "array",
          cellDates: true,
        });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const sourceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
          sheet,
          { defval: "" },
        );
        if (!sourceRows.length)
          return notify(
            "Le fichier Excel Total ne contient aucune transaction",
          );
        const hasAmountColumn = Object.keys(sourceRows[0]).some(
          (header) => normalizedKey(header) === "montant",
        );
        if (!hasAmountColumn)
          return notify(
            'Colonne "Montant" introuvable : utilisez le fichier de transactions exporté depuis TotalEnergies',
          );
        const sourceHeaders = Object.keys(sourceRows[0]).map(normalizedKey);
        if (!sourceHeaders.includes("nomdeproduit"))
          return notify(
            'Colonne « Nom de produit » introuvable dans le fichier TotalEnergies',
          );
        if (!sourceHeaders.includes("nomdelastation"))
          return notify(
            'Colonne « Nom de la station » introuvable dans le fichier TotalEnergies',
          );
        const paymentNumberKey = totalPaymentNumberKey(sourceRows[0]);
        if (!paymentNumberKey)
          return notify(
            'Colonne « Numéro du mode de paiement » introuvable dans le fichier TotalEnergies',
          );
        const normalized = sourceRows.map((source, index) =>
          totalTransaction(source, file.name, index),
        );
        const invalidDateRow = normalized.findIndex((row) => !String(row.dateApi));
        if (invalidDateRow >= 0)
          return notify(`Date ou heure de transaction invalide à la ligne ${invalidDateRow + 2}. Import annulé pour empêcher tout doublon.`);
        const missingCardRow = normalized.findIndex(
          (row) => !String(row.carte).replace(/\D/g, ""),
        );
        if (missingCardRow >= 0)
          return notify(
            `Numéro du mode de paiement absent à la ligne ${missingCardRow + 2}. Import annulé pour éviter de regrouper les consommations sur une seule carte.`,
          );
        const missingProductRow = normalized.findIndex(
          (row) => !String(row.produit).trim() || row.produit === "—",
        );
        if (missingProductRow >= 0)
          return notify(`Nom de produit absent à la ligne ${missingProductRow + 2}. Import annulé.`);
        const missingStationRow = normalized.findIndex(
          (row) => !String(row.station).trim() || row.station === "—",
        );
        if (missingStationRow >= 0)
          return notify(`Nom de la station absent à la ligne ${missingStationRow + 2}. Import annulé.`);
        if (!token) return notify("Session distante expirée : reconnectez-vous");
        const response=await fetch(`${API}/transactions/import`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({filename:file.name,rows:normalized.map(row=>({date:String(row.dateApi),cardNumber:String(row.carte),vehicle:String(row.vehicule??""),beneficiary:String(row.beneficiaire??""),station:String(row.station??""),product:String(row.produit??""),liters:parseNumeric(row.litres),amount:parseNumeric(row.montant),previousMileage:parseNumeric(row.kilometragePrecedent)||undefined,mileage:parseNumeric(row.kilometrage)||undefined,authorizationCode:String(row.codeAutorisation??"")||undefined}))})});
        if(!response.ok) throw new Error(await response.text());
        const result=await response.json();
        setRefreshTick(value=>value+1);
        setView("dashboard");
        notify(`${result.imported} transaction(s) · ${result.verified ?? 0} facture(s) correcte(s) · ${result.mismatches ?? 0} écart(s) · ${result.unpriced ?? 0} tarif(s) manquant(s) · ${result.duplicates} doublon(s)`);
      } catch (error) {
        const raw=error instanceof Error?error.message:"";
        try { const parsed=JSON.parse(raw); return notify(String(parsed.message??raw)); }
        catch { return notify(raw||"Fichier Total illisible : vérifiez le format Excel ou CSV"); }
      }
    } else notify("Paramètres enregistrés");
    setModal(null);
    setSelected(null);
  }
  async function decideRequest(id: string, accepted: boolean) {
    if (
      !user ||
      !["ZIN_FINANCE", "SUPER_ADMIN", "DIRECTION_GENERAL"].includes(user.role)
    )
      return notify("Décision réservée à Zin et à la Direction");
    const request = data.requests.find((x) => x.id === id);
    if (!request) return notify("Demande introuvable");
    if (request.statut !== "EN_ATTENTE_ZIN")
      return notify("Cette demande a déjà été traitée");
    const reason = window.prompt(
      accepted
        ? "Observation de validation (optionnelle)"
        : "Motif du refus (obligatoire)",
      "",
    );
    if (!accepted && !reason?.trim())
      return notify("Le motif du refus est obligatoire");

    const isLimitChange = request.type === "Augmentation de plafond";
    const isFunding=request.type==="Alimentation de carte";
    const isCustody=request.type==="Mise en coffre"||request.type==="Distribution de carte";
    const isNewCard=request.type==="Nouvelle carte";
    if (isLimitChange||isFunding||isCustody||isNewCard) {
      if (!token) return notify("Session distante expirée : reconnectez-vous");
      try {
        const apiResponse = await fetch(`${API}/requests/${id}/decision`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ decision: accepted ? "APPROVED" : "REJECTED", reason: reason || undefined }),
        });
        if (!apiResponse.ok) throw new Error(await apiResponse.text());
        const decision=await apiResponse.json();
        setRefreshTick(value=>value+1);
        notify(!accepted?"Demande refusée":decision.pendingSecondApproval?"Votre accord est enregistré. La deuxième autorisation Zin/DG reste obligatoire.":isCustody?"Changement coffre / distribution validé par Zin et la DG":isNewCard?`Carte ${request.carte} sortie du coffre et attribuée`:`${isFunding?"Alimentation":"Plafond"} de la carte ${request.carte} validé`);
      } catch (error) {
        const raw=error instanceof Error?error.message:"";
        try {
          const parsed=JSON.parse(raw);
          const message=Array.isArray(parsed.message)?parsed.message.join(" · "):parsed.message;
          notify(String(message||"La validation n’a pas pu être enregistrée"));
        } catch {
          notify(raw||"La validation n’a pas pu être enregistrée");
        }
      }
      return;
    }

    let nextCards = cards;
    let nextData: Record<string, Row[]>;
    let cardNumber = "";
    if (accepted) {
      cardNumber = String(
        window.prompt("Numéro de la carte Total attribuée (obligatoire)", "") ??
          "",
      ).trim();
      if (!cardNumber)
        return notify(
          "Le numéro de carte est obligatoire pour valider la demande",
        );
      if (
        cards.some(
          (card) =>
            card.masked_card_number.replace(/\s/g, "") ===
            cardNumber.replace(/\s/g, ""),
        )
      )
        return notify("Ce numéro de carte existe déjà");

      const beneficiary = String(request.beneficiaire ?? "").trim();
      const department = String(request.departement ?? "").trim();
      const registration = String(request.voiture ?? "").trim();
      const existingVehicle = data.vehicles.find(
        (vehicle) =>
          String(vehicle.immatriculation).toLowerCase() ===
          registration.toLowerCase(),
      );
      const currentOffPark = cards.find((candidate) => {
        if (candidate.card_category !== "OFF_PARK" || candidate.status !== "ACTIVE") return false;
        const consumed = data.transactions
          .filter((row) => String(row.carte) === candidate.masked_card_number)
          .reduce((sum, row) => sum + parseNumeric(row.montant), 0);
        return consumed < candidate.monthly_limit;
      });
      const card: Card = {
        id: crypto.randomUUID(),
        masked_card_number: cardNumber,
        company_code: "NAJIB",
        beneficiary,
        department,
        registration,
        vehicle_model: existingVehicle
          ? String(existingVehicle.marque ?? "")
          : "À compléter",
        monthly_limit: parseNumeric(request.plafond),
        status: currentOffPark ? "TO_ASSIGN" : "ACTIVE",
        finance_status: "CONFIRMED",
        created_at: new Date().toLocaleDateString("fr-MA"),
        updated_at: new Date().toLocaleDateString("fr-MA"),
        card_category: "OFF_PARK",
        old_card_id: currentOffPark?.id,
        activation_locked: Boolean(currentOffPark),
      };
      nextCards = [card, ...cards];

      const beneficiaryIndex = data.beneficiaries.findIndex(
        (row) => String(row.nom).toLowerCase() === beneficiary.toLowerCase(),
      );
      const beneficiaries =
        beneficiaryIndex >= 0
          ? data.beneficiaries.map((row, index) =>
              index === beneficiaryIndex
                ? {
                    ...row,
                    service: department,
                    carte: cardNumber,
                    vehicule: registration,
                    statut: "Actif",
                  }
                : row,
            )
          : [
              {
                id: crypto.randomUUID(),
                nom: beneficiary,
                service: department,
                carte: cardNumber,
                vehicule: registration,
                statut: "Actif",
              },
              ...data.beneficiaries,
            ];
      const vehicleIndex = data.vehicles.findIndex(
        (row) =>
          String(row.immatriculation).toLowerCase() ===
          registration.toLowerCase(),
      );
      const vehicles =
        vehicleIndex >= 0
          ? data.vehicles.map((row, index) =>
              index === vehicleIndex
                ? {
                    ...row,
                    beneficiaire: beneficiary,
                    carte: cardNumber,
                    statut: "Actif",
                  }
                : row,
            )
          : [
              {
                id: crypto.randomUUID(),
                immatriculation: registration,
                marque: "À compléter",
                beneficiaire: beneficiary,
                carte: cardNumber,
                statut: "Actif",
              },
              ...data.vehicles,
            ];
      nextData = {
        ...data,
        beneficiaries,
        vehicles,
        requests: data.requests.map((row) =>
          row.id === id
            ? {
                ...row,
                statut: "VALIDEE_ZIN",
                motif: reason || "Validée",
                carte: cardNumber,
                dateValidation: new Date().toLocaleString("fr-MA"),
              }
            : row,
        ),
      };
    } else {
      nextData = {
        ...data,
        requests: data.requests.map((row) =>
          row.id === id
            ? {
                ...row,
                statut: "REFUSEE_ZIN",
                motif: reason || "Refusée",
                dateValidation: new Date().toLocaleString("fr-MA"),
              }
            : row,
        ),
      };
    }

    if (!token) return notify("Session distante expirée : reconnectez-vous");
    try {
      const apiResponse = await fetch(`${API}/requests/${id}/decision`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          decision: accepted ? "APPROVED" : "REJECTED",
          reason: reason || undefined,
          cardNumber: accepted ? cardNumber : undefined,
        }),
      });
      if (!apiResponse.ok) throw new Error(await apiResponse.text());
    } catch {
      return notify("Échec de la décision distante : aucune modification enregistrée");
    }

    const response: Notification = {
      id: crypto.randomUUID(),
      target: "NAJIB_ASSIGNER",
      title: accepted ? "Carte créée et demande validée" : "Demande refusée",
      message: accepted
        ? `${request.numero} — carte ${cardNumber} validée${nextCards[0]?.activation_locked ? ", verrouillée jusqu’à consommation à 100% de l’ancienne carte" : " et active"}`
        : `${request.numero} — ${reason}`,
      view: accepted ? "cards" : "requests",
      read: false,
      createdAt: new Date().toLocaleString("fr-MA"),
    };
    const nextNotifications = [response, ...notifications];
    setCards(nextCards);
    setData(nextData);
    setNotifications(nextNotifications);
    notify(
      accepted
        ? nextCards[0]?.activation_locked
          ? "Carte validée mais verrouillée : l’ancienne carte doit atteindre 100 %"
          : "Carte créée, affectée et visible dans tous les modules"
        : "Demande refusée — Najib a été notifié",
    );
  }
  async function cancelRequest(id: string) {
    if (!user || user.role !== "NAJIB_ASSIGNER")
      return notify("Annulation réservée au responsable ayant créé la demande");
    const request = data.requests.find((row) => row.id === id);
    if (!request) return notify("Demande introuvable");
    if (request.statut !== "EN_ATTENTE_ZIN")
      return notify("Seule une demande en attente peut être annulée");
    if (!window.confirm(`Annuler définitivement la demande ${request.numero} ?`))
      return;
    if (!token) return notify("Session distante expirée : reconnectez-vous");
    try {
      const response = await fetch(`${API}/requests/${id}/cancel`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(await response.text());
    } catch {
      return notify("Échec de l’annulation distante : aucune modification enregistrée");
    }
    const nextData = {
      ...data,
      requests: data.requests.map((row) =>
        row.id === id
          ? {
              ...row,
              statut: "ANNULEE_NAJIB",
              motif: "Annulée par Najib",
              dateValidation: new Date().toLocaleString("fr-MA"),
            }
          : row,
      ),
    };
    const cancellations: Notification[] = (["ZIN_FINANCE", "DIRECTION_GENERAL", "SUPER_ADMIN"] as Role[]).map((target) => ({
      id: crypto.randomUUID(),
      target,
      title: "Demande annulée",
      message: `${request.numero} a été annulée par Najib`,
      view: "requests",
      read: false,
      createdAt: new Date().toLocaleString("fr-MA"),
    }));
    const nextNotifications = [...cancellations, ...notifications];
    setData(nextData);
    setNotifications(nextNotifications);
    notify("Demande annulée — Zin et la Direction ont été informés");
  }
  async function archiveRequest(id: string) {
    if (!user || user.role !== "ZIN_FINANCE") return notify("Archivage réservé à Zin Finance");
    const request = data.requests.find((row) => row.id === id);
    if (!request) return notify("Demande introuvable");
    if (request.statut === "EN_ATTENTE_ZIN") return notify("Traitez la demande avant de l’archiver");
    if (!window.confirm(`Archiver ${request.numero} ? Elle disparaîtra de la liste active, mais restera conservée dans l’historique et l’audit.`)) return;
    if (!token) return notify("Session distante expirée : reconnectez-vous");
    try {
      const response = await fetch(`${API}/requests/${id}/archive`, { method:"PATCH", headers:{ Authorization:`Bearer ${token}` } });
      if (!response.ok) throw new Error(await response.text());
      setData((current) => ({ ...current, requests:current.requests.filter((row) => row.id !== id) }));
      notify(`Demande ${request.numero} archivée`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Échec de l’archivage");
    }
  }
  async function refreshFuelPrices() {
    if (!token) return notify("Session distante expirée");
    try {
      const response=await fetch(`${API}/fuel-prices/refresh-tunisia`,{method:"POST",headers:{Authorization:`Bearer ${token}`}});
      if(!response.ok)throw new Error(await response.text());
      const result=await response.json();setRefreshTick(value=>value+1);
      const billing=result.billing;
      notify(billing
        ? `Contrôle terminé : ${billing.verified} correcte(s) · ${billing.mismatches} écart(s) · ${billing.unpriced} tarif(s) manquant(s)`
        : result.changed?`${result.changed} prix officiel(s) modifié(s) — Zin et la DG ont été notifiés`:"Prix officiels vérifiés : aucun changement");
    } catch(error){notify(error instanceof Error?error.message:"Actualisation impossible");}
  }
  async function observeTransaction(row:Row) {
    const observation=window.prompt("Observation à transmettre à la Direction Générale",String(row.observation??""));
    if(!observation?.trim()||observation.trim().length<3)return;
    if(!token)return notify("Session distante expirée");
    try{
      const response=await fetch(`${API}/transactions/${row.id}/observations`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({observation:observation.trim()})});
      if(!response.ok)throw new Error(await response.text());setRefreshTick(value=>value+1);notify("Observation transmise à la Direction Générale");
    }catch(error){notify(error instanceof Error?error.message:"Observation non enregistrée");}
  }
  async function archiveTransaction(row:Row){
    if(!user||!canManage(user.role))return notify("Archivage réservé à Zin et à la Direction");
    if(!token)return notify("Session expirée : reconnectez-vous");
    if(!window.confirm(`Archiver la transaction de la carte ${String(row.carte??"—")} ? Elle restera disponible dans l’historique.`))return;
    try{
      const response=await fetch(`${API}/transactions/${row.id}/archive`,{method:"PATCH",headers:{Authorization:`Bearer ${token}`}});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(String(body.message??"Archivage impossible"));
      setRefreshTick(value=>value+1);notify("Transaction archivée — historique conservé");
    }catch(error){notify(error instanceof Error?error.message:"Archivage impossible");}
  }
  async function deleteRow(
    section: "transactions" | "vehicles" | "beneficiaries",
    id?: string,
  ) {
    if (!user || (section === "vehicles" ? !canManageFleet(user.role) : !canManage(user.role)))
      return notify("Vous ne disposez pas du droit de suppression");
    if (section !== "transactions" && section !== "vehicles" && !isDirection(user.role))
      return notify("Zin peut supprimer uniquement les transactions");
    if (section === "vehicles" && id) {
      const vehicle = data.vehicles.find((row) => row.id === id);
      const registration = String(vehicle?.immatriculation ?? "").trim().toLowerCase();
      if (registration && cards.some((card) => String(card.registration ?? "").trim().toLowerCase() === registration))
        return notify("Suppression impossible : ce véhicule est encore lié à une carte. Modifiez d’abord l’affectation de la carte.");
    }
    const label = id ? "cet enregistrement" : "toutes les transactions";
    if (!window.confirm(`Confirmer la suppression de ${label} ?`)) return;
    if (section === "transactions") {
      if (!token) return notify("Session expirée : reconnectez-vous");
      try {
        const response = await fetch(
          id ? `${API}/transactions/${id}` : `${API}/transactions/batch/all`,
          { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
        );
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json() as { deleted?: number };
        if (!id && Number(result.deleted ?? 0) < 1 && data.transactions.length > 0)
          throw new Error("Aucune transaction n’a été supprimée par l’API");
      } catch (error) {
        const raw = error instanceof Error ? error.message : "";
        try {
          const parsed = JSON.parse(raw);
          return notify(String(parsed.message ?? "Suppression non enregistrée"));
        } catch {
          return notify(raw || "Suppression non enregistrée dans la base");
        }
      }
    }
    const next = {
      ...data,
      [section]: id ? data[section].filter((row) => row.id !== id) : [],
    };
    setData(next);
    persist(cards, next);
    setRefreshTick((value) => value + 1);
    notify(
      id
        ? "Enregistrement supprimé"
        : "Toutes les transactions ont été supprimées",
    );
  }
  function editTransaction(row: Row) {
    if (!user || !canManage(user.role))
      return notify("Najib peut seulement consulter les transactions");
    const station = window.prompt("Station", String(row.station ?? ""));
    if (station === null) return;
    const litres = window.prompt(
      "Volume (ex. 100 L)",
      String(row.litres ?? ""),
    );
    if (litres === null) return;
    const montant = window.prompt(
      "Montant (ex. 400 TND)",
      String(row.montant ?? ""),
    );
    if (montant === null) return;
    const reason = window.prompt(
      "Motif obligatoire de la correction",
      "Correction après contrôle du fichier Total",
    );
    if (!reason?.trim())
      return notify("Le motif de correction est obligatoire");
    const next = {
      ...data,
      transactions: data.transactions.map((x) =>
        x.id === row.id
          ? {
              ...x,
              station,
              litres,
              montant,
              statut: "Importée Total · corrigée",
              correction: reason,
              corrigeeLe: new Date().toLocaleString("fr-MA"),
            }
          : x,
      ),
    };
    setData(next);
    persist(cards, next);
    notify("Transaction corrigée — révision journalisée");
  }
  function allocateConsumption(row: Row) {
    if (!user || user.role !== "NAJIB_ASSIGNER") return notify("Répartition réservée au responsable hors parc");
    const cardKey=String(row.carte).replace(/\D/g,"").replace(/^0+/,"");
    const card = cards.find((item) => item.masked_card_number.replace(/\D/g,"").replace(/^0+/,"") === cardKey);
    if (!card) return notify("Carte introuvable dans votre périmètre");
    const originalAmount = parseNumeric(row.montant);
    const alreadyAllocated = parseNumeric(row.montantReparti);
    const remaining = Math.max(0, originalAmount - alreadyAllocated);
    if (!remaining) return notify("Cette transaction est entièrement répartie");
    setAllocationRow(row);
  }
  async function submitAllocation(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!allocationRow || !user || user.role !== "NAJIB_ASSIGNER") return;
    const f = new FormData(e.currentTarget);
    const beneficiaryName = String(f.get("beneficiaryName") ?? "").trim();
    const vehicleId = String(f.get("vehicleId") ?? "").trim();
    const amount = parseNumeric(f.get("amount"));
    const originalAmount = parseNumeric(allocationRow.montant);
    const alreadyAllocated = parseNumeric(allocationRow.montantReparti);
    const remaining = Math.max(0, originalAmount - alreadyAllocated);
    if (!beneficiaryName) return notify("Le nom du bénéficiaire est obligatoire");
    if (!vehicleId) return notify("Le véhicule est obligatoire");
    if (amount <= 0 || amount > remaining) return notify("Le montant réparti doit être positif et ne peut pas dépasser le reste");
    if(!token)return notify("Session distante expirée");
    const selectedVehicle=data.vehicles.find(row=>String(row.id)===vehicleId);
    const mileageValue=window.prompt(`Kilométrage réel obligatoire du véhicule ${String(selectedVehicle?.immatriculation??"")} après cette transaction`,String(selectedVehicle?.kilometrage??""));
    if(mileageValue===null)return;
    const mileage=parseNumeric(mileageValue);
    if(!Number.isFinite(mileage)||mileage<Number(selectedVehicle?.kilometrage??0))return notify(`Le kilométrage doit être supérieur ou égal à ${Number(selectedVehicle?.kilometrage??0)} km`);
    let pendingAllocationId="";try{const response=await fetch(`${API}/transactions/${allocationRow.id}/allocations`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({beneficiaryName,vehicleId,amount,mileage,note:"Répartition de consommation par Najib"})});if(!response.ok)throw new Error(await response.text());const created=await response.json();pendingAllocationId=String(created.id);}catch(error){return notify(error instanceof Error?error.message:"La répartition n’a pas été enregistrée dans la base");}
    const vehicle=String(selectedVehicle?.immatriculation??"");
    const allocation = `${beneficiaryName} — ${vehicle} — ${amount.toFixed(3)} DT — ${mileage} km`;
    const next = { ...data, transactions: data.transactions.map((item) => item.id === allocationRow.id ? {
      ...item,
      montantReparti: alreadyAllocated + amount,
      repartitionEnAttente:pendingAllocationId,
      repartition: item.repartition ? `${item.repartition} | ${allocation}` : allocation,
      derniereRepartition: new Date().toLocaleString("fr-MA"),
    } : item) };
    setData(next); persist(cards, next);
    setAllocationRow(null);
    notify(`Répartition envoyée pour validation Zin/DG. Total original inchangé : ${originalAmount.toFixed(3)} DT`);
  }
  const consumptionRate = (card: Card) => Math.min(100,Number(card.consumption_rate??0));
  const cardsForUser =
    selectedClientId ? cards.filter(card=>card.company_id===selectedClientId) : cards;
  const selectedClient=companies.find(company=>company.id===selectedClientId);
  function chooseClient(companyId:string){
    sessionStorage.setItem("delta_client",companyId);
    setSelectedClientId(companyId);
    setShowClientChooser(false);
    setView("dashboard");
  }
  function openNotifications(notification: Notification) {
    const next = notifications.map((n) =>
      n.id === notification.id ? { ...n, read: true } : n,
    );
    setNotifications(next);
    if (token && !notification.read)
      fetch(`${API}/notifications/${notification.id}/read`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    setShowNotifications(false);
    setView(notification.view);
  }
  async function markAllNotifications(read: boolean) {
    if (!token) return;
    const previous = notifications;
    setNotifications((items) => items.map((item) => ({ ...item, read })));
    try {
      const response = await fetch(`${API}/notifications/${read ? "read-all" : "unread-all"}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error();
      notify(read ? "Toutes vos notifications sont marquées comme lues" : "Toutes vos notifications sont marquées comme non lues");
    } catch {
      setNotifications(previous);
      notify("La mise à jour des notifications a échoué");
    }
  }
  function openCard(card: Card) {
    setSelected(card);
    setModal("cardAction");
  }
  async function resolveAnomaly(id: string) {
    if(!token) return notify("Session expirée");
    try {
      const response=await fetch(`${API}/dashboard/anomalies/${id}/resolve`,{method:"PATCH",headers:{Authorization:`Bearer ${token}`}});
      if(!response.ok) throw new Error(await response.text());
      setData(current=>({...current,anomalies:current.anomalies.filter(row=>row.id!==id)}));
      setRefreshTick(value=>value+1);
      notify("Anomalie résolue");
    } catch(error) {
      notify(error instanceof Error?error.message:"Impossible de résoudre l’anomalie");
    }
  }
  async function decideTransactionReview(id:string,accepted:boolean) {
    if(!token) return notify("Session expirée");
    const reason=accepted?"":window.prompt("Motif du refus","");
    if(!accepted&&!reason?.trim()) return notify("Le motif du refus est obligatoire");
    let fuelCardId:string|undefined,vehicleId:string|undefined,newVehicleRegistration:string|undefined,newVehicleType:string|undefined,newVehicleCompanyId:string|undefined,beneficiaryName:string|undefined;
    if(accepted){
      const review=data.anomalies.find(row=>row.id===id)??data.transactions.find(row=>String(row.reviewId)===id);
      const requestedCard=window.prompt("Numéro de la carte à affecter",String(review?.carte??""));
      if(requestedCard===null)return;
      const cardKey=requestedCard.replace(/\D/g,"");
      const selectedCard=cards.find(card=>{
        const current=card.masked_card_number.replace(/\D/g,"");
        return current===cardKey||(cardKey.length>6&&current===cardKey.slice(-6));
      });
      if(!selectedCard)return notify("Carte introuvable : saisissez un numéro présent dans la liste des cartes");
      const requestedVehicle=window.prompt("Immatriculation du véhicule à affecter",String(review?.vehicule??""));
      if(requestedVehicle===null)return;
      const vehicleKey=normalizedKey(requestedVehicle);
      const selectedVehicle=data.vehicles.find(vehicle=>normalizedKey(String(vehicle.immatriculation))===vehicleKey);
      if(selectedVehicle)vehicleId=selectedVehicle.id;
      else {
        if(["horsparc","c4","citroenc4"].includes(vehicleKey))return notify("Cette valeur n’est pas une immatriculation. Choisissez un véhicule existant avec sa vraie plaque.");
        if(!window.confirm(`Le véhicule ${requestedVehicle} est absent de la liste. Voulez-vous le créer et l’affecter ?`))return;
        const companyCode=window.prompt("Société du nouveau véhicule",selectedCard.company_code);
        if(companyCode===null)return;
        const selectedCompany=companies.find(company=>normalizedKey(company.code)===normalizedKey(companyCode));
        if(!selectedCompany)return notify("Société introuvable : utilisez un code présent dans la liste des sociétés");
        const type=window.prompt("Type du nouveau véhicule (obligatoire)","");
        if(!type?.trim())return notify("Le type du véhicule est obligatoire");
        const holder=window.prompt("Nom du bénéficiaire / conducteur",String(review?.beneficiaire??selectedCard.beneficiary??""));
        if(!holder?.trim())return notify("Le nom du bénéficiaire est obligatoire");
        newVehicleRegistration=requestedVehicle.trim();newVehicleType=type.trim();newVehicleCompanyId=selectedCompany.id;beneficiaryName=holder.trim();
      }
      fuelCardId=selectedCard.id;
    }
    try { const response=await fetch(`${API}/transactions/reviews/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({decision:accepted?"ACCEPTED":"REJECTED",reason:reason||undefined,fuelCardId,vehicleId,newVehicleRegistration,newVehicleType,newVehicleCompanyId,beneficiaryName})}); if(!response.ok) throw new Error(await response.text());
      setData(current=>({...current,transactions:current.transactions.filter(row=>String(row.reviewId)!==id),anomalies:current.anomalies.map(row=>row.id===id?{...row,statut:accepted?"Acceptée":"Refusée"}:row)})); notify(accepted?"Transaction enregistrée : véhicule, bénéficiaire et carte liés automatiquement":"Transaction refusée et classée");
    } catch (error) {
      const raw=error instanceof Error?error.message:"";
      try { const parsed=JSON.parse(raw); notify(Array.isArray(parsed.message)?parsed.message.join(" · "):String(parsed.message??raw)); }
      catch { notify(raw||"La décision n’a pas pu être enregistrée"); }
    }
  }
  async function decideMileage(id:string,accepted:boolean){if(!token)return notify("Session expirée");const reason=window.prompt(accepted?"Observation de validation (optionnelle)":"Motif du refus","");if(!accepted&&!reason?.trim())return notify("Le motif du refus est obligatoire");try{const response=await fetch(`${API}/mileage/${id}/decision`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({decision:accepted?"VALIDATED":"REJECTED",reason:reason||undefined})});if(!response.ok)throw new Error(await response.text());setData(current=>({...current,mileage:current.mileage.map(row=>row.id===id?{...row,statut:accepted?"VALIDEE_ZIN":"REFUSEE_ZIN"}:row)}));notify(accepted?"Kilométrage validé":"Kilométrage refusé");}catch{return notify("Décision kilométrique non enregistrée");}}
  async function decideAllocation(id:string,accepted:boolean){if(!token)return notify("Session expirée");const reason=window.prompt(accepted?"Observation de validation (optionnelle)":"Motif du refus","");if(!accepted&&!reason?.trim())return notify("Motif obligatoire");try{const response=await fetch(`${API}/transactions/allocations/${id}/decision`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({decision:accepted?"APPROVED":"REJECTED",reason:reason||undefined})});if(!response.ok)throw new Error(await response.text());setData(current=>({...current,transactions:current.transactions.map(row=>row.repartitionEnAttente===id?{...row,repartitionEnAttente:""}:row)}));notify(accepted?"Répartition validée":"Répartition refusée");}catch{return notify("Décision non enregistrée");}}
  if (!token || !user)
    return <Login onSubmit={login} loading={loading} error={error} />;
  const localSummary = {
    totalCards: cardsForUser.length,
    activeCards: cardsForUser.filter((c) =>
      ["ACTIVE", "DISTRIBUTED"].includes(c.status),
    ).length,
    pending: cardsForUser.filter((c) => c.finance_status === "PENDING").length,
    opposed: cardsForUser.filter((c) =>
      ["LOST", "STOLEN", "OPPOSED"].includes(c.status),
    ).length,
    liters: data.transactions.reduce(
      (total, row) => total + parseNumeric(row.litres),
      0,
    ),
    amount: data.transactions.reduce(
      (total, row) => total + parseNumeric(row.montant),
      0,
    ),
  };
  const summary = databaseSummary ? { ...localSummary, ...databaseSummary, liters:Number(databaseSummary.liters??0), amount:Number(databaseSummary.amount??0), pending: Number(databaseSummary.openRequests??0), opposed:Number(databaseSummary.blockedCards??0) } : localSummary;
  const allNav: [View, IconName, string][] = [
    ["dashboard", "dashboard", "Vue d’ensemble"], ["reports", "reports", "Rapports Direction"],
    ["cards", "cards", "Cartes carburant"], ["beneficiaries", "users", "Bénéficiaires"],
    ["vehicles", "vehicle", "Véhicules"], ["drivers", "driver", "Chauffeurs"],
    ["transactions", "transactions", "Transactions"], ["requests", "requests", "Demandes"],
    ["mileage", "mileage", "Kilométrage"], ["fuelPrices", "fuel", "Prix carburants"],
    ["anomalies", "alert", "Anomalies"],
    ["complaints", "requests", "Réclamations"],
    ["returns", "transfer", "Restitution des cartes"],
    ["documents", "reports", "Factures"],
  ];
  const nav =
    user.role === "NAJIB_ASSIGNER"
      ? allNav.filter(([v]) =>
          ["dashboard", "cards", "vehicles", "drivers", "transactions", "requests", "mileage", "fuelPrices", "complaints", "returns", "documents"].includes(v),
        )
      : isDirection(user.role)
        ? allNav
        : allNav.filter(([v]) => v !== "reports");
  const userNotifications = notifications.filter((n) => n.target === user.role),
    unread = userNotifications.filter((n) => !n.read).length;
  const currentMonthKey=new Date().toISOString().slice(0,7);
  const monthlyCardsToRecover=cardsForUser.filter(card=>
    ["ACTIVE","DISTRIBUTED","ASSIGNED"].includes(card.status)&&
    Boolean(card.responsible_user_id)&&
    (user.role!=="NAJIB_ASSIGNER"||card.responsible_user_id===user.id)&&
    !data.returnReceipts.some(receipt=>receipt.carte===card.masked_card_number&&receipt.moisCle===currentMonthKey)
  );
  return (
    <div className={styles.app}>
      {showClientChooser&&companies.length>0&&<div className={styles.clientChooserBackdrop} role="dialog" aria-modal="true" aria-labelledby="client-title"><section className={styles.clientChooser}><div className={styles.clientChooserBrand}><Image src="/brand/delta-logo.png" alt="Delta Carburant" width={110} height={110}/></div><small>BIENVENUE SUR DELTA CARBURANT</small><h2 id="client-title">Veuillez choisir un client pour continuer</h2><p>La situation, les cartes et les alertes seront affichées dans le contexte de la société sélectionnée.</p><div className={styles.clientList}>{companies.map((company,index)=><button type="button" key={company.id} onClick={()=>chooseClient(company.id)}><span>{String(index+1).padStart(2,"0")}</span><div><b>{company.name}</b><small>{company.code}</small></div><i>›</i></button>)}</div></section></div>}
      {sessionSeconds !== null && (
        <div className={styles.sessionOverlay} role="dialog" aria-modal="true" aria-labelledby="session-title">
          <section className={styles.sessionDialog}>
            <div className={styles.sessionShield}>✓</div>
            <p className={styles.sessionEyebrow}>SÉCURITÉ DE LA SESSION</p>
            <h2 id="session-title">Votre session arrive à expiration</h2>
            <p>Pour protéger les données de Delta Carburant, vous serez automatiquement déconnecté si vous ne confirmez pas votre présence.</p>
            <div className={styles.sessionCountdown} aria-live="polite">
              <strong>{String(Math.floor(sessionSeconds / 60)).padStart(2,"0")}:{String(sessionSeconds % 60).padStart(2,"0")}</strong>
              <span>temps restant</span>
            </div>
            <div className={styles.sessionIdentity}><span>{user.name.charAt(0)}</span><div><b>{user.name}</b><small>{roleLabel(user.role)} · session JWT sécurisée</small></div></div>
            <div className={styles.sessionActions}>
              <button type="button" onClick={() => logout()}>Quitter maintenant</button>
              <button type="button" onClick={continueSession} disabled={extendingSession}>{extendingSession ? "Prolongation…" : "Continuer ma session"}</button>
            </div>
          </section>
        </div>
      )}
      <aside className={styles.sidebar} aria-label="Navigation principale">
        <div className={styles.brand}>
          <Image src="/brand/delta-logo.png" alt="Delta Carburant" width={148} height={148} priority />
        </div>
        <nav aria-label="Modules de l’application">
          {nav.map((n) => (
            <button
              key={n[0]}
              className={view === n[0] ? styles.active : ""}
              title={n[2]}
              aria-current={view === n[0] ? "page" : undefined}
              onClick={() => {
                setView(n[0]);
                setSearch("");
              }}
            >
              <AppIcon name={n[1]} /> <span>{n[2]}</span>
            </button>
          ))}
        </nav>
        <div className={styles.sideBottom}>
          <button
            className={view === "settings" ? styles.active : ""}
            aria-current={view === "settings" ? "page" : undefined}
            title="Paramètres"
            onClick={() => { setView("settings"); setSearch(""); }}
          >
            <AppIcon name="settings" /> <span>Paramètres</span>
          </button>
          <button onClick={() => logout()} title="Déconnexion">
            <AppIcon name="logout" /> <span>Déconnexion</span>
          </button>
        </div>
      </aside>
      <main className={styles.content}>
        <header>
          <div>
            <p className={styles.eyebrow}>
              <i className={styles.liveDot} /> ESPACE {roleLabel(user.role).toUpperCase()} · DONNÉES SYNCHRONISÉES
            </p>
            <h1>{viewMeta[view][0]}</h1>
            <p>{viewMeta[view][1]}</p>
          </div>
          <div className={styles.headerActions}>
            <button className={styles.clientSwitch} onClick={()=>setShowClientChooser(true)} title="Changer de client"><small>CLIENT</small><b>{selectedClient?.code??"Choisir"}</b><i>⌄</i></button>
            <button className={styles.recoveryCounter} onClick={()=>setView("returns")} title="Cartes distribuées restant à récupérer ce mois">
              <AppIcon name="transfer" size={18}/><span><b>{monthlyCardsToRecover.length}</b><small>à récupérer</small></span>
            </button>
            <div className={styles.notificationBox}>
              <button
                className={styles.bell}
                onClick={() => setShowNotifications(!showNotifications)}
              >
                <AppIcon name="bell" size={19}/>{unread > 0 && <span>{unread}</span>}
              </button>
              {showNotifications && typeof document !== "undefined" && createPortal(
                <TopLayerDialog onClose={() => setShowNotifications(false)}><div className={styles.notificationMenu}>
                  <div className={styles.notificationHeader}>
                    <div><h3>Notifications</h3><small>Privées · {roleLabel(user.role)}</small></div>
                    <div className={styles.notificationHeaderActions}><span>{unread} non lue{unread > 1 ? "s" : ""}</span><button aria-label="Fermer" onClick={() => setShowNotifications(false)}>×</button></div>
                  </div>
                  {userNotifications.length > 0 && (
                    <div className={styles.notificationTools}>
                      <button type="button" onClick={() => void markAllNotifications(true)} disabled={unread === 0}>✓ Tout lire</button>
                      <button type="button" onClick={() => void markAllNotifications(false)} disabled={unread === userNotifications.length}>○ Tout non lu</button>
                    </div>
                  )}
                  {userNotifications.length ? (
                    userNotifications.map((n) => (
                      <button
                        key={n.id}
                        className={n.read ? "" : styles.unread}
                        onClick={() => openNotifications(n)}
                      >
                        <b>{n.title}</b>
                        <span>{n.message}</span>
                        <small>{n.createdAt}</small>
                      </button>
                    ))
                  ) : (
                    <div className={styles.notificationEmpty}><AppIcon name="bell" size={25}/><b>Tout est sous contrôle</b><p>Aucune nouvelle notification pour le moment.</p></div>
                  )}
                </div></TopLayerDialog>,
                document.body,
              )}
            </div>
            <div className={styles.user}>
              <span>{user.name[0]}</span>
              <div>
                <b>{user.name}</b>
                <small>{roleLabel(user.role)}</small>
              </div>
            </div>
          </div>
        </header>
        {error && <div className={styles.alert}>{error}</div>}
        <WorkflowGuide role={user.role} activeView={view} go={setView} />
        {view === "dashboard" ? (
          <Dashboard
            token={token}
            summary={summary}
            cards={cardsForUser}
            transactions={data.transactions}
            user={user}
            go={setView}
            open={setModal}
            edit={openCard}
            analytics={directionData}
          />
        ) : view === "reports" ? (
          <DirectionReports cards={cards} transactions={data.transactions} analytics={directionData} operationalData={data} />
        ) : view === "complaints" ? (
          <ComplaintsView token={token} user={user} rows={data.complaints} refresh={()=>setRefreshTick(value=>value+1)} notify={notify}/>
        ) : view === "returns" ? (
          <CardReturnsView token={token} user={user} cards={cardsForUser} requests={data.requests} receipts={data.returnReceipts} decide={decideRequest} refresh={()=>setRefreshTick(value=>value+1)} notify={notify}/>
        ) : view === "documents" ? (
          <DocumentsView token={token} notify={notify}/>
        ) : view === "settings" ? (
          <Settings
            token={token}
            user={user}
            notify={notify}
            onSynced={() => setRefreshTick((current) => current + 1)}
            reset={() => {
              localStorage.removeItem("delta_app_data_v1");
              setCards(initialCards);
              setData(seeds);
              setNotifications([]);
              notify("Données réinitialisées");
            }}
          />
        ) : (
          <DataView
            view={view}
            cards={cardsForUser}
            data={data}
            user={user}
            search={search}
            setSearch={setSearch}
            open={setModal}
            edit={openCard}
            editTransaction={editTransaction}
            allocateConsumption={allocateConsumption}
            archiveTransaction={archiveTransaction}
            deleteRow={deleteRow}
            editVehicle={(row) => {
              if (!canManage(user.role)) return notify("Najib peut uniquement consulter les véhicules");
              setEditingRow({ view: "vehicles", row });
              setModal("editRow");
            }}
            resolve={resolveAnomaly}
            decideReview={decideTransactionReview}
            decideMileage={decideMileage}
            decideAllocation={decideAllocation}
            decideRequest={decideRequest}
            cancelRequest={cancelRequest}
            archiveRequest={archiveRequest}
            refreshFuelPrices={refreshFuelPrices}
            observeTransaction={observeTransaction}
          />
        )}
      </main>
      {allocationRow && user?.role === "NAJIB_ASSIGNER" && (() => {
        const original = parseNumeric(allocationRow.montant);
        const allocated = parseNumeric(allocationRow.montantReparti);
        const remaining = Math.max(0, original - allocated);
        const availableVehicles = data.vehicles.filter(
          (row) => String(row.immatriculation ?? "").trim() && String(row.immatriculation) !== "À COMPLÉTER",
        );
        return (
          <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && setAllocationRow(null)}>
            <form className={styles.modal} onSubmit={submitAllocation}>
              <div className={styles.modalHead}>
                <div>
                  <h2>Répartir la consommation</h2>
                  <p>Carte {allocationRow.carte} · transaction Total du {allocationRow.date}</p>
                </div>
                <button type="button" onClick={() => setAllocationRow(null)}>×</button>
              </div>
              <div className={styles.allocationBalance}>
                <span><small>Montant Total original</small><b>{original.toFixed(3)} TND</b></span>
                <span><small>Déjà réparti</small><b>{allocated.toFixed(3)} TND</b></span>
                <span><small>Reste disponible</small><b>{remaining.toFixed(3)} TND</b></span>
              </div>
              <div className={styles.formGrid}>
                <label>
                  Bénéficiaire
                  <input name="beneficiaryName" required minLength={2} placeholder="Nom du bénéficiaire" />
                  <small>Najib peut créer directement le bénéficiaire, sans code chauffeur.</small>
                </label>
                <label>
                  Matricule du véhicule
                  <select name="vehicleId" required defaultValue="">
                    <option value="" disabled>Choisir dans le parc automobile</option>
                    {availableVehicles.map((vehicle) => (
                      <option value={String(vehicle.id)} key={String(vehicle.id)}>
                        {String(vehicle.immatriculation)} · {String(vehicle.type)} · {String(vehicle.reference)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.fullField}>
                  Montant consommé à affecter (TND)
                  <input name="amount" type="number" min="0.001" max={remaining} step="0.001" defaultValue={remaining.toFixed(3)} required />
                </label>
                <div className={styles.workflowInfo}>
                  <b>Traçabilité TotalEnergies conservée</b>
                  <span>Le bénéficiaire, le véhicule, le montant et le kilométrage sont enregistrés ensemble. Le total réparti ne peut jamais dépasser la transaction Total.</span>
                </div>
              </div>
              <div className={styles.modalActions}>
                <button type="button" onClick={() => setAllocationRow(null)}>Annuler</button>
                <button type="submit">Enregistrer la répartition</button>
              </div>
            </form>
          </div>
        );
      })()}
      {toast && <div className={styles.toast}>✓ {toast}</div>}
      {modal && (
        <ModalForm
          type={modal}
          card={selected}
          cards={[...cards,...safeCards.filter(safe=>!cards.some(card=>card.id===safe.id))]}
          vehicles={data.vehicles}
          responsibles={responsibles}
          companies={companies}
          editingRow={editingRow}
          user={user}
          close={() => {
            setModal(null);
            setSelected(null);
            setEditingRow(null);
          }}
          submit={
            modal === "editRow"
              ? async (e) => {
                  e.preventDefault();
                  if (!editingRow) return;
                  const values = Object.fromEntries(
                    new FormData(e.currentTarget).entries(),
                  ) as Row;
                  values.id = editingRow.row.id;
                  if (editingRow.view === "vehicles") {
                    const registration = String(values.immatriculation ?? "").trim().toUpperCase();
                    if (!registration) return notify("La matricule est obligatoire");
                    if (!String(values.type ?? "").trim()) return notify("Le type de véhicule est obligatoire");
                    if (!String(values.societe ?? "").trim()) return notify("La société est obligatoire");
                    if (data.vehicles.some((row) => row.id !== values.id && String(row.immatriculation).trim().toUpperCase() === registration))
                      return notify("Cette matricule existe déjà");
                    values.immatriculation = registration;
                    const company=companies.find(item=>item.code.toLowerCase()===String(values.societe).trim().toLowerCase());
                    if(!company)return notify("Société inconnue : choisissez une société existante");
                    if(!token)return notify("Session distante expirée");
                    let reconciliation:{matched?:number;transactions?:number;cards?:{number:string;holder?:string}[]}={};
                    try {
                      const response=await fetch(`${API}/vehicles/${values.id}`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({companyId:company.id,registration,brand:String(values.reference??"")||undefined,model:String(values.type),active:String(values.statut??"Actif")!=="Inactif"})});
                      if(!response.ok)throw new Error(await response.text());
                      const saved=await response.json(); reconciliation=saved.reconciliation??{};
                    } catch(error) {
                      return notify(error instanceof Error?error.message:"La modification du véhicule n’a pas été enregistrée");
                    }
                    setRefreshTick(value=>value+1);
                    if(Number(reconciliation.matched)>0){
                      const found=reconciliation.cards?.map(card=>`${card.number}${card.holder?` (${card.holder})`:""}`).join(", ");
                      notify(`Correspondance Total trouvée : carte ${found} · ${reconciliation.transactions??0} transaction(s) liée(s) au véhicule ${registration}`);
                    } else notify(`Véhicule ${registration} enregistré. Aucune carte Total correspondante trouvée pour cette plaque.`);
                  }
                  const next = {
                    ...data,
                    [editingRow.view]: data[editingRow.view].map((r) =>
                      r.id === values.id ? values : r,
                    ),
                  };
                  setData(next);
                  persist(cards, next);
                  setModal(null);
                  setEditingRow(null);
                  if(editingRow.view!=="vehicles") notify("Modification enregistrée");
                }
              : submit
          }
        />
      )}
    </div>
  );
}

function WorkflowGuide({
  role,
  activeView,
  go,
}: {
  role: Role;
  activeView: View;
  go: (view: View) => void;
}) {
  const workflow = roleWorkflows[role];
  return (
    <section className={styles.workflowGuide} aria-label="Parcours utilisateur">
      <div className={styles.workflowGuideIntro}>
        <span className={styles.guideIcon}>✓</span>
        <div>
          <p className={styles.eyebrow}>VOTRE PARCOURS · {roleLabel(role).toUpperCase()}</p>
          <h2>Que devez-vous faire ?</h2>
          <p>{workflow.intro}</p>
        </div>
      </div>
      <div className={styles.workflowSteps}>
        {workflow.steps.map((step, index) => {
          const active = step.view === activeView;
          return (
            <button
              type="button"
              key={`${step.number}-${step.title}`}
              className={active ? styles.workflowStepActive : ""}
              onClick={() => go(step.view)}
              aria-current={active ? "step" : undefined}
            >
              <span className={styles.stepNumber}>{step.number}</span>
              <span className={styles.stepCopy}>
                <b>{step.title}</b>
                <small>{step.description}</small>
              </span>
              <span className={styles.stepArrow}>{index === workflow.steps.length - 1 ? "Ouvrir" : "→"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Dashboard({
  token,
  summary,
  cards,
  transactions,
  user,
  go,
  open,
  edit,
  analytics,
}: {
  token:string;
  summary: Record<string, number>;
  cards: Card[];
  transactions: Row[];
  user: User;
  go: (v: View) => void;
  open: (m: Modal) => void;
  edit: (c: Card) => void;
  analytics: Record<string,unknown>|null;
}) {
  const currentMonth=new Date().toISOString().slice(0,7);
  const [historyMonth,setHistoryMonth]=useState(currentMonth);
  const [history,setHistory]=useState<Record<string,unknown>|null>(null);
  useEffect(()=>{let cancelled=false;fetch(`${API}/dashboard/history?month=${historyMonth}`,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'}).then(response=>response.ok?response.json():Promise.reject()).then(payload=>{if(!cancelled)setHistory(payload)}).catch(()=>{if(!cancelled)setHistory(null)});return()=>{cancelled=true}},[token,historyMonth]);
  const historyCards=(history?.cards??[]) as Record<string,unknown>[];
  const periodCards=cards.map(card=>{const item=historyCards.find(row=>String(row.id)===card.id);return {...card,consumed_amount:Number(item?.consumed??0),consumption_rate:Math.min(100,Number(item?.rate??0))};});
  const [overviewSearch, setOverviewSearch] = useState("");
  const query = normalizedKey(overviewSearch);
  const overviewCards = periodCards
    .filter((card) => !query || [
      card.masked_card_number,
      card.beneficiary,
      card.department,
      card.registration,
      card.vehicle_model,
      card.company_code,
      status(card.status),
    ].some((value) => normalizedKey(String(value ?? "")).includes(query)))
    .sort((a,b)=>{
      const rate=(card:Card)=>Math.min(100,Math.max(0,Number(card.consumption_rate??0)));
      const closed=(card:Card)=>["SAFE","SUSPENDED","OPPOSED","REPLACED"].includes(card.status);
      const aReached=rate(a)>=100;
      const bReached=rate(b)>=100;
      if(aReached!==bReached)return aReached?-1:1;
      if(aReached&&closed(a)!==closed(b))return closed(a)?-1:1;
      return rate(b)-rate(a)
        || Number(b.consumed_amount??0)-Number(a.consumed_amount??0)
        || a.masked_card_number.localeCompare(b.masked_card_number,"fr");
    });
  const activeCards = cards.filter((card) => ["ACTIVE","DISTRIBUTED","ASSIGNED"].includes(card.status));
  const safeCards = cards.filter((card) => card.status === "SAFE");
  const activeMonthlyLimit = activeCards.reduce((sum, card) => sum + Number(card.monthly_limit ?? 0), 0);
  const safeCardsLimit = safeCards.reduce((sum, card) => sum + Number(card.monthly_limit ?? 0), 0);
  const totalMonthlyLimit = activeMonthlyLimit + safeCardsLimit;
  const officialMonthlyConsumed = Number(history?.amount??summary.officialMonthAmount ??
    activeCards.reduce((sum, card) => sum + Number(card.consumed_amount ?? 0), 0));
  const utilization = activeMonthlyLimit ? Math.round((officialMonthlyConsumed / activeMonthlyLimit) * 100) : 0;
  const cardsAtRisk = activeCards.filter((card) => Number(card.consumption_rate ?? 0) >= 80);
  const openAnomalies = Number(analytics?.openAnomalies ?? 0);
  const billingMismatches = Number(analytics?.billingMismatches ?? 0);
  return (
    <>
      <section className={styles.periodFilter}><div><small>HISTORIQUE D’UTILISATION</small><h2>Période affichée</h2><p>Tous les indicateurs ci-dessous correspondent uniquement au mois sélectionné.</p></div><label>Mois et année<input type="month" value={historyMonth} max={currentMonth} onChange={event=>setHistoryMonth(event.target.value)}/></label><div><b>{Number(history?.transactions??0).toLocaleString('fr-FR')}</b><span>transactions</span></div><div><b>{Number(history?.liters??0).toLocaleString('fr-FR',{maximumFractionDigits:3})} L</b><span>volume du mois</span></div></section>
      {isDirection(user.role) && <section className={styles.executiveHero}>
        <div className={styles.executiveHeroCopy}>
          <span className={styles.executiveLabel}>COCKPIT EXÉCUTIF · TEMPS RÉEL</span>
          <h2>La consommation du parc est à <strong>{utilization}%</strong> de la ligne distribuée.</h2>
          <p>Une lecture immédiate de la performance, des risques et des décisions à prendre sur le mois en cours.</p>
          <div className={styles.executiveHeroActions}>
            <button onClick={() => go("reports")}><AppIcon name="reports" size={17}/> Ouvrir l’analyse Direction</button>
            <button onClick={() => go("anomalies")}><AppIcon name="alert" size={17}/> Examiner les alertes</button>
          </div>
        </div>
        <div className={styles.executivePulse}>
          <div style={{"--rate":`${Math.min(100, utilization)}%`} as React.CSSProperties}><strong>{utilization}%</strong><span>utilisé</span></div>
          <small>Actualisé depuis Total Mobility</small>
        </div>
        <div className={styles.executiveSignals}>
          <article className={openAnomalies ? styles.signalDanger : styles.signalGood}><span><AppIcon name="alert" size={18}/></span><div><small>Anomalies ouvertes</small><strong>{openAnomalies}</strong></div></article>
          <article className={billingMismatches ? styles.signalWarning : styles.signalGood}><span><AppIcon name="check" size={18}/></span><div><small>Écarts de facturation</small><strong>{billingMismatches}</strong></div></article>
          <article className={cardsAtRisk.length ? styles.signalWarning : styles.signalGood}><span><AppIcon name="cards" size={18}/></span><div><small>Cartes à surveiller</small><strong>{cardsAtRisk.length}</strong></div></article>
        </div>
      </section>}
      <section className={styles.metrics}>
        <Metric
          icon="sum"
          color="blue"
          label="Plafond mensuel total"
          value={`${totalMonthlyLimit.toLocaleString("fr-FR")} TND`}
          note={`${cards.length} cartes au total`}
        />
        <Metric
          icon="safe"
          color="orange"
          label="Plafond en coffre — Oui"
          value={`${safeCardsLimit.toLocaleString("fr-FR")} TND`}
          note={`${safeCards.length} carte(s) non distribuée(s)`}
        />
        <Metric
          icon="active"
          color="green"
          label="Plafond distribué — Coffre Non"
          value={`${activeMonthlyLimit.toLocaleString("fr-FR")} TND`}
          note={`${activeCards.length} carte(s) distribuée(s)`}
        />
        <Metric
          icon="fuel"
          color="violet"
          label="Consommation mensuelle Total"
          value={`${officialMonthlyConsumed.toLocaleString("fr-FR",{maximumFractionDigits:3})} TND`}
          note={`Source Total · toutes les transactions du mois`}
        />
      </section>
      {isDirection(user.role)&&<MonthlyConsumptionGauge
        consumed={officialMonthlyConsumed}
        creditLine={activeMonthlyLimit}
      />}
      {isDirection(user.role)&&historyMonth===currentMonth&&<DailyConsumptionHistogram transactions={transactions}/>}
      {isDirection(user.role)&&<CardPortfolioOverview cards={periodCards} go={go}/>}
      <section className={styles.overviewPanel}>
        <div className={styles.overviewToolbar}>
          <div>
            <h2>Contrôle global des cartes et consommations</h2>
            <p>{overviewCards.length} carte(s) affichée(s) sur {cards.length} · triées de 100 % à 0 % · historique de {new Date(`${historyMonth}-01T12:00:00`).toLocaleDateString('fr-FR',{month:'long',year:'numeric'})}</p>
          </div>
          <input
            value={overviewSearch}
            onChange={(event) => setOverviewSearch(event.target.value)}
            placeholder="Carte, bénéficiaire, véhicule, société…"
          />
        </div>
        <CardTable cards={overviewCards} transactions={transactions} user={user} edit={edit} full />
      </section>
      <section className={styles.dashboardActions}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h2>Actions autorisées</h2>
              <p>{permissionText(user.role)}</p>
            </div>
          </div>
          <div className={styles.actions}>
            {canCreate(user.role) && (
              <Action
                icon="plus"
                title="Nouvelle carte"
                sub="Créer une carte"
                onClick={() => open("card")}
              />
            )}
            {canConfirm(user.role) && (
              <Action
                icon="check"
                title="Validations finance"
                sub={`${summary.pending} carte(s) à confirmer`}
                onClick={() => go("cards")}
              />
            )}
            {canAssign(user.role) && (
              <Action
                icon="transfer"
                title="Affecter une carte"
                sub="Choisir une carte disponible"
                onClick={() => go("cards")}
              />
            )}
            <Action
              icon="fuel"
              title="Suivre les consommations"
              sub="Transactions TotalEnergies"
              onClick={() => go("transactions")}
            />
          </div>
        </div>
      </section>
    </>
  );
}

function CardPortfolioOverview({cards,go}:{cards:Card[];go:(view:View)=>void}){
  const active=cards.filter(card=>card.status==="ACTIVE");
  const usage=(card:Card)=>Math.min(100,Number(card.consumption_rate??(card.monthly_limit?100*Number(card.consumed_amount??0)/card.monthly_limit:0)));
  const bands=[
    {label:"Plafond dépassé",value:active.filter(card=>usage(card)>=100).length,tone:"danger"},
    {label:"À surveiller · 80–99 %",value:active.filter(card=>usage(card)>=80&&usage(card)<100).length,tone:"warning"},
    {label:"Utilisation normale · 30–79 %",value:active.filter(card=>usage(card)>=30&&usage(card)<80).length,tone:"good"},
    {label:"Faible utilisation · < 30 %",value:active.filter(card=>usage(card)<30).length,tone:"neutral"},
  ];
  const top=[...active].sort((a,b)=>usage(b)-usage(a)).slice(0,6);
  const statusItems=Object.entries(cards.reduce<Record<string,number>>((acc,card)=>{acc[status(card.status)]=(acc[status(card.status)]??0)+1;return acc;},{})).map(([name,value])=>({name,value}));
  return <section className={styles.portfolioGrid}>
    <article className={styles.portfolioCard}>
      <div className={styles.portfolioHead}><div><small>PORTEFEUILLE CARTES</small><h3>Niveaux d’utilisation du plafond</h3></div><button onClick={()=>go("cards")}>Voir les cartes</button></div>
      <div className={styles.usageBands}>{bands.map(band=><div key={band.label} className={styles[`usage_${band.tone}`]}><strong>{band.value}</strong><span>{band.label}</span></div>)}</div>
    </article>
    <article className={styles.portfolioCard}>
      <div className={styles.portfolioHead}><div><small>SUIVI PRIORITAIRE</small><h3>Cartes les plus consommées</h3></div><button onClick={()=>go("transactions")}>Transactions</button></div>
      <div className={styles.cardUsageList}>{top.length?top.map(card=>{const rate=usage(card);return <div key={card.id}><span><b>{card.masked_card_number}</b><small>{card.beneficiary??"Non affectée"}</small></span><i><em style={{width:`${Math.min(100,rate)}%`}}/></i><strong>{rate.toFixed(0)} %</strong></div>}):<p className={styles.inlineEmpty}>Aucune carte active.</p>}</div>
    </article>
    <article className={styles.portfolioCard}>
      <div className={styles.portfolioHead}><div><small>ÉTAT DU PARC</small><h3>Répartition des cartes</h3></div></div>
      <Bars items={statusItems} unit="cartes"/>
    </article>
  </section>;
}
function DirectionReports({
  cards,
  transactions,
  analytics,
  operationalData,
}: {
  cards: Card[];
  transactions: Row[];
  analytics: Record<string,unknown>|null;
  operationalData: Record<string, Row[]>;
}) {
  const [company, setCompany] = useState("Toutes"),
    [beneficiary, setBeneficiary] = useState("Tous"),
    [department, setDepartment] = useState("Tous"),
    [cardStatus, setCardStatus] = useState("Tous"),
    [responsible, setResponsible] = useState("Tous"),
    [vehicle, setVehicle] = useState("Tous"),
    [product, setProduct] = useState("Tous"),
    [station, setStation] = useState("Toutes"),
    [period, setPeriod] = useState("CURRENT_MONTH");
  const filteredCards = cards.filter(
    (c) =>
      (company === "Toutes" || c.company_code === company) &&
      (beneficiary === "Tous" || c.beneficiary === beneficiary) &&
      (department === "Tous" || (c.department??"Non renseigné") === department) &&
      (responsible === "Tous" || (c.responsible_name??"Non affecté") === responsible) &&
      (vehicle === "Tous" || (c.registration??"Sans véhicule") === vehicle) &&
      (cardStatus === "Tous" || c.status === cardStatus),
  );
  const periodStart=(()=>{const now=new Date();if(period==="ALL")return null;if(period==="LAST_90_DAYS")return new Date(now.getFullYear(),now.getMonth(),now.getDate()-89);if(period==="LAST_12_MONTHS")return new Date(now.getFullYear(),now.getMonth()-11,1);return new Date(now.getFullYear(),now.getMonth(),1)})();
  const filteredTx = transactions.filter((t) => {
    const day=transactionDay(t.date), txDate=day?new Date(`${day}T12:00:00`):null;
    return filteredCards.some((c) => c.masked_card_number === String(t.carte)) &&
      (product==="Tous"||String(t.produit)===product) &&
      (station==="Toutes"||String(t.station)===station) &&
      (vehicle==="Tous"||String(t.vehicule)===vehicle) &&
      (!periodStart||(txDate!==null&&txDate>=periodStart));
  });
  const liters = (rows: Row[]) =>
    rows.reduce((n, r) => n + parseNumeric(r.litres), 0);
  const active = filteredCards.filter((c) => c.status === "ACTIVE").length,
    limit = filteredCards
      .filter((c) => c.status === "ACTIVE")
      .reduce((n, c) => n + Number(c.monthly_limit ?? 0), 0);
  const utilization = limit
    ? Math.min(
        100,
        Math.round(
          (filteredTx.reduce((n, r) => n + parseNumeric(r.montant), 0) /
            limit) *
            100,
        ),
      )
    : 0;
  const companies = [...new Set(cards.map((c) => c.company_code))],
    beneficiaries = [
      ...new Set(cards.map((c) => c.beneficiary).filter(Boolean)),
    ] as string[];
  const byBeneficiary = beneficiaries
    .map((name) => ({
      name,
      value: liters(filteredTx.filter((t) => t.beneficiaire === name)),
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 7);
  const totalAmount = filteredTx.reduce(
    (sum, row) => sum + parseNumeric(row.montant),
    0,
  );
  const cardUsage=(card:Card)=>Math.min(100,Number(card.consumption_rate??(card.monthly_limit?100*Number(card.consumed_amount??0)/card.monthly_limit:0)));
  const consumed=filteredCards.reduce((sum,card)=>sum+Number(card.consumed_amount??0),0);
  const available=Math.max(0,limit-consumed);
  const overLimit=filteredCards.filter(card=>card.status==="ACTIVE"&&cardUsage(card)>=100);
  const warningCards=filteredCards.filter(card=>card.status==="ACTIVE"&&cardUsage(card)>=80&&cardUsage(card)<100);
  const unusedCards=filteredCards.filter(card=>card.status==="ACTIVE"&&cardUsage(card)<10);
  const topCards=[...filteredCards].filter(card=>card.status==="ACTIVE").sort((a,b)=>cardUsage(b)-cardUsage(a)).slice(0,10);
  const departments=[...new Set(cards.map(card=>card.department??"Non renseigné"))].sort();
  const statusOptions=[...new Set(cards.map(card=>card.status))];
  const responsibles=[...new Set(cards.map(card=>card.responsible_name??"Non affecté"))].sort();
  const vehicleOptions=[...new Set([...cards.map(card=>card.registration??"Sans véhicule"),...transactions.map(row=>String(row.vehicule??"—"))])].filter(value=>value!=="—").sort();
  const products=[...new Set(transactions.map(row=>String(row.produit??"—")))].filter(value=>value!=="—").sort();
  const stations=[...new Set(transactions.map(row=>String(row.station??"—")))].filter(value=>value!=="—").sort();
  const activeFilters = Number(company !== "Toutes") + Number(beneficiary !== "Tous")+Number(department!=="Tous")+Number(cardStatus!=="Tous")+Number(responsible!=="Tous")+Number(vehicle!=="Tous")+Number(product!=="Tous")+Number(station!=="Toutes")+Number(period!=="CURRENT_MONTH");
  const monthAmount=filteredTx.reduce((sum,row)=>sum+parseNumeric(row.montant),0);
  const monthLiters=filteredTx.reduce((sum,row)=>sum+parseNumeric(row.litres),0);
  const vehicles=operationalData.vehicles??[];
  const activeVehicles=vehicles.filter(row=>String(row.statut)==="Actif").length;
  const outOfServiceVehicles=vehicles.length-activeVehicles;
  const assignedVehicles=new Set(filteredCards.map(card=>card.registration).filter(Boolean)).size;
  const safeCardsCount=filteredCards.filter(card=>card.status==="SAFE").length;
  const blockedCardsCount=filteredCards.filter(card=>["SUSPENDED","LOST","STOLEN","OPPOSED"].includes(card.status)).length;
  const pendingRequests=(operationalData.requests??[]).filter(row=>!["VALIDEE_ZIN","REFUSEE_ZIN","ANNULEE_NAJIB"].includes(String(row.statut))).length;
  const billingMismatches=filteredTx.filter(row=>String(row.controleFacturation)==="BILLING_MISMATCH").length;
  const billingExposure=filteredTx.reduce((sum,row)=>sum+(String(row.controleFacturation)==="BILLING_MISMATCH"?Math.abs(parseNumeric(row.ecartFacturation)):0),0);
  const reviewedAnomalies=(operationalData.anomalies??[]).filter(row=>String(row.statut)==="À vérifier").length;
  const averageTransaction=filteredTx.length?monthAmount/filteredTx.length:0;
  const averageLiters=filteredTx.length?monthLiters/filteredTx.length:0;
  const scopedMileage=(operationalData.mileage??[]).filter(row=>(vehicle==="Tous"||String(row.vehicule)===vehicle)&&(company==="Toutes"||String(row.societe)===company));
  const totalDistance=scopedMileage.reduce((sum,row)=>sum+parseNumeric(row.distanceDetectee),0);
  const mileageAnomalies=scopedMileage.filter(row=>String(row.anomalie)==="Oui").length;
  const validatedMileage=scopedMileage.filter(row=>String(row.statut)==="VALIDEE_ZIN").length;
  const mileageConsumption=scopedMileage.map(row=>parseNumeric(row.consommation100km)).filter(value=>value>0);
  const averageConsumption100=mileageConsumption.length?mileageConsumption.reduce((sum,value)=>sum+value,0)/mileageConsumption.length:0;
  const costPerKm=totalDistance>0?monthAmount/totalDistance:0;
  const litersPer100=totalDistance>0?monthLiters/totalDistance*100:averageConsumption100;
  const vehicleRegistrations=new Set((operationalData.vehicles??[]).filter(row=>(company==="Toutes"||String(row.societe)===company)&&(vehicle==="Tous"||String(row.immatriculation)===vehicle)).map(row=>String(row.immatriculation)));
  const mileageVehicles=new Set(scopedMileage.map(row=>String(row.vehicule)));
  const vehiclesWithoutMileage=[...vehicleRegistrations].filter(registration=>!mileageVehicles.has(registration));
  const txByVehicle=Object.values(filteredTx.reduce<Record<string,{name:string;amount:number;liters:number;count:number}>>((acc,row)=>{const name=String(row.vehicule??"Non identifié");const item=acc[name]??{name,amount:0,liters:0,count:0};item.amount+=parseNumeric(row.montant);item.liters+=parseNumeric(row.litres);item.count++;acc[name]=item;return acc;},{})).sort((a,b)=>b.amount-a.amount);
  const txByCompany=companies.map(code=>{const companyCards=cards.filter(card=>card.company_code===code);const numbers=new Set(companyCards.map(card=>card.masked_card_number));const rows=filteredTx.filter(row=>numbers.has(String(row.carte)));return {code,cards:companyCards.length,active:companyCards.filter(card=>card.status==="ACTIVE").length,transactions:rows.length,liters:liters(rows),amount:rows.reduce((sum,row)=>sum+parseNumeric(row.montant),0)};}).filter(row=>company==="Toutes"||row.code===company).sort((a,b)=>b.amount-a.amount);
  const topFiveShare=monthAmount?100*txByVehicle.slice(0,5).reduce((sum,row)=>sum+row.amount,0)/monthAmount:0;
  const pendingMileage=scopedMileage.filter(row=>String(row.statut)==="EN_ATTENTE_ZIN").length;
  return (
    <section className={styles.reportShell}>
      <div className={styles.reportTitle}>
        <div className={styles.reportBrand}>
          <span>Δ</span>
          <div><b>DeltaCarburant</b><small>Centre de pilotage exécutif</small></div>
        </div>
        <div className={styles.reportHeading}>
          <small>VISION CONSOLIDÉE · MOIS EN COURS</small>
          <h2>Pilotage cartes, plafonds et consommations</h2>
        </div>
        <div className={styles.reportLive}><i /> Données Total synchronisées</div>
      </div>
      <div className={styles.reportContext}>
        <span className={styles.contextPrimary}>Direction Générale</span>
        <span>Période · Mois en cours</span>
        <span>{filteredTx.length} transactions analysées</span>
        <span>{filteredCards.length} cartes dans le périmètre</span>
        <strong>{totalAmount.toLocaleString("fr-FR", { maximumFractionDigits: 3 })} TND analysés</strong>
      </div>
      <div className={styles.reportLayout}>
        <div>
          <div className={styles.executiveStrip}>
            <ReportKpi label="CONSOMMATION DU MOIS" value={`${monthAmount.toLocaleString("fr-FR",{maximumFractionDigits:3})} TND`} meta="Transactions Total du périmètre" tone="money"/>
            <ReportKpi label="PLAFOND DISTRIBUÉ" value={`${limit.toLocaleString("fr-FR")} TND`} meta={`${active} cartes actives`} tone="volume"/>
            <ReportKpi label="SOLDE DISPONIBLE" value={`${available.toLocaleString("fr-FR")} TND`} meta={`${utilization} % du plafond utilisé`} tone={utilization>=90?"danger":utilization>=75?"warning":"good"}/>
            <ReportKpi label="VOLUME DU MOIS" value={`${monthLiters.toLocaleString("fr-FR",{maximumFractionDigits:3})} L`} meta={`${filteredTx.length} transactions`} tone="default"/>
          </div>
          <div className={styles.reportKpis}>
            <ReportKpi label="PLAFOND DÉPASSÉ" value={overLimit.length} meta="Cartes nécessitant une action" tone={overLimit.length?"danger":"good"}/>
            <ReportKpi label="SEUIL 80 % ATTEINT" value={warningCards.length} meta="Cartes à surveiller" tone={warningCards.length?"warning":"good"}/>
            <ReportKpi label="FAIBLE UTILISATION" value={unusedCards.length} meta="Moins de 10 % consommé" tone="default"/>
            <ReportKpi label="ANOMALIES OUVERTES" value={Number(analytics?.openAnomalies??0)} meta="Actions de contrôle" tone={Number(analytics?.openAnomalies??0)?"danger":"good"}/>
          </div>
          <DailyConsumptionHistogram transactions={filteredTx}/>
          <section className={styles.flowKpiSection}>
            <div className={styles.flowKpiHeading}><div><small>COUVERTURE COMPLÈTE DE LA PLATEFORME</small><h3>Indicateurs de tous les flux opérationnels</h3></div><span>Données réelles · mois en cours</span></div>
            <div className={styles.flowKpiGrid}>
              <ReportKpi label="VÉHICULES DU PARC" value={vehicles.length} meta={`${activeVehicles} actifs · ${outOfServiceVehicles} hors service`} tone="default"/>
              <ReportKpi label="VÉHICULES AFFECTÉS" value={assignedVehicles} meta="Reliés aux cartes du périmètre" tone="good"/>
              <ReportKpi label="CARTES ACTIVES" value={active} meta={`${safeCardsCount} en coffre · ${blockedCardsCount} bloquées`} tone="volume"/>
              <ReportKpi label="TRANSACTIONS TOTAL" value={filteredTx.length} meta={`${averageTransaction.toLocaleString("fr-FR",{maximumFractionDigits:3})} TND en moyenne`} tone="money"/>
              <ReportKpi label="CARBURANT MOYEN / PLEIN" value={`${averageLiters.toLocaleString("fr-FR",{maximumFractionDigits:2})} L`} meta={`${monthLiters.toLocaleString("fr-FR",{maximumFractionDigits:2})} L consommés`} tone="default"/>
              <ReportKpi label="TAUX D’UTILISATION" value={`${utilization} %`} meta={`${available.toLocaleString("fr-FR",{maximumFractionDigits:3})} TND disponibles`} tone={utilization>=90?"danger":utilization>=75?"warning":"good"}/>
              <ReportKpi label="CONTRÔLE FACTURATION" value={billingMismatches} meta={`${billingExposure.toLocaleString("fr-FR",{maximumFractionDigits:3})} TND d’écart`} tone={billingMismatches?"danger":"good"}/>
              <ReportKpi label="WORKFLOWS À TRAITER" value={pendingRequests+reviewedAnomalies} meta={`${pendingRequests} demandes · ${reviewedAnomalies} contrôles`} tone={pendingRequests+reviewedAnomalies?"warning":"good"}/>
            </div>
          </section>
          <section className={styles.dgAnalysisSection}>
            <div className={styles.flowKpiHeading}><div><small>PERFORMANCE DU PARC</small><h3>Kilométrage, rendement et maîtrise des coûts</h3></div><span>{scopedMileage.length} relevés analysés</span></div>
            <div className={styles.dgAnalysisKpis}>
              <ReportKpi label="DISTANCE CONTRÔLÉE" value={`${totalDistance.toLocaleString("fr-FR")} km`} meta={`${validatedMileage} relevés validés`} tone="volume"/>
              <ReportKpi label="CONSOMMATION MOYENNE" value={litersPer100?`${litersPer100.toLocaleString("fr-FR",{maximumFractionDigits:2})} L/100 km`:"—"} meta="Selon relevés et transactions filtrés" tone={litersPer100>12?"warning":"good"}/>
              <ReportKpi label="COÛT CARBURANT / KM" value={costPerKm?`${costPerKm.toLocaleString("fr-FR",{maximumFractionDigits:3})} TND/km`:"—"} meta="Montant Total / distance contrôlée" tone="money"/>
              <ReportKpi label="QUALITÉ KILOMÉTRAGE" value={mileageAnomalies} meta={`${pendingMileage} en attente · ${vehiclesWithoutMileage.length} véhicules sans relevé`} tone={mileageAnomalies||vehiclesWithoutMileage.length?"danger":"good"}/>
            </div>
            <div className={styles.dgInsightGrid}>
              <article><div className={styles.dgPanelHead}><div><small>CLASSEMENT VÉHICULES</small><h4>Coût et consommation par véhicule</h4></div><span>Top 10</span></div><div className={styles.dgVehicleTable}><div><b>Véhicule</b><b>Transactions</b><b>Litres</b><b>Montant</b></div>{txByVehicle.slice(0,10).map(row=><div key={row.name}><strong>{row.name}</strong><span>{row.count}</span><span>{row.liters.toLocaleString("fr-FR",{maximumFractionDigits:2})} L</span><span>{row.amount.toLocaleString("fr-FR",{maximumFractionDigits:3})} DT</span></div>)}{!txByVehicle.length&&<p className={styles.inlineEmpty}>Aucune transaction véhicule dans le périmètre.</p>}</div></article>
              <article className={styles.dgDecisionPanel}><div className={styles.dgPanelHead}><div><small>LECTURE DIRECTION</small><h4>Points de décision prioritaires</h4></div></div>
                <div className={overLimit.length?styles.decisionDanger:styles.decisionGood}><b>{overLimit.length} carte(s) au plafond</b><span>{overLimit.length?"Bloquer, alimenter ou récupérer après contrôle.":"Aucun dépassement de plafond détecté."}</span></div>
                <div className={mileageAnomalies||vehiclesWithoutMileage.length?styles.decisionWarning:styles.decisionGood}><b>{mileageAnomalies} anomalie(s) kilométrique(s)</b><span>{vehiclesWithoutMileage.length} véhicule(s) sans relevé dans le périmètre.</span></div>
                <div className={billingMismatches?styles.decisionDanger:styles.decisionGood}><b>{billingMismatches} écart(s) de facturation</b><span>Exposition financière : {billingExposure.toLocaleString("fr-FR",{maximumFractionDigits:3})} TND.</span></div>
                <div className={topFiveShare>70?styles.decisionWarning:styles.decisionGood}><b>Concentration Top 5 : {topFiveShare.toFixed(1)} %</b><span>Part des cinq véhicules les plus coûteux dans la dépense filtrée.</span></div>
              </article>
            </div>
          </section>
          <section className={styles.dgCompanySection}>
            <div className={styles.flowKpiHeading}><div><small>CONSOLIDATION GROUPE</small><h3>Situation complète par société</h3></div><span>{txByCompany.length} société(s)</span></div>
            <div className={styles.dgCompanyTable}><div><b>Société</b><b>Cartes</b><b>Actives</b><b>Transactions</b><b>Volume</b><b>Dépense</b><b>Part groupe</b></div>{txByCompany.map(row=><div key={row.code}><strong>{row.code}</strong><span>{row.cards}</span><span>{row.active}</span><span>{row.transactions}</span><span>{row.liters.toLocaleString("fr-FR",{maximumFractionDigits:2})} L</span><span>{row.amount.toLocaleString("fr-FR",{maximumFractionDigits:3})} DT</span><span>{monthAmount?`${(100*row.amount/monthAmount).toFixed(1)} %`:"0 %"}</span></div>)}</div>
          </section>
          <section className={styles.dgControlGrid}>
            <article><h3>Utilisation par carte</h3><div className={styles.dgCardTable}>
              <div className={styles.dgCardTableHead}><span>Carte / bénéficiaire</span><span>Consommé</span><span>Plafond</span><span>Utilisation</span><span>Solde</span></div>
              {topCards.length?topCards.map(card=>{const rate=cardUsage(card),amount=Number(card.consumed_amount??0);return <div key={card.id} className={rate>=100?styles.dgCritical:rate>=80?styles.dgWarning:""}><span><b>{card.masked_card_number}</b><small>{card.beneficiary??"Non affectée"}</small></span><span>{amount.toLocaleString("fr-FR")} DT</span><span>{card.monthly_limit.toLocaleString("fr-FR")} DT</span><span><i><em style={{width:`${Math.min(100,rate)}%`}}/></i><b>{rate.toFixed(0)} %</b></span><span>{Math.max(0,card.monthly_limit-amount).toLocaleString("fr-FR")} DT</span></div>}):<p className={styles.inlineEmpty}>Aucune carte dans ce périmètre.</p>}
            </div></article>
            <article><h3>Consommation par bénéficiaire</h3>{byBeneficiary.some(item=>item.value>0)?<Bars items={byBeneficiary}/>:<p className={styles.inlineEmpty}>Aucune consommation disponible pour ce périmètre.</p>}</article>
          </section>
          {analytics&&<section className={styles.intelligenceGrid}>
            {((analytics.products??[]) as Record<string,unknown>[]).length>0&&<article><h3>Répartition par produit</h3><Bars items={((analytics.products??[]) as Record<string,unknown>[]).map(row=>({name:String(row.product),value:Number(row.liters??0)}))}/></article>}
            <article className={styles.riskPanel}><h3>Contrôles intelligents</h3>{((analytics.risks??[]) as Record<string,unknown>[]).length?((analytics.risks??[]) as Record<string,unknown>[]).slice(0,8).map((row,index)=><div key={`${String(row.id)}-${index}`}><b>{String(row.reason)}</b><span>Carte {String(row.card)} · {String(row.station??"—")} · {Number(row.amount??0).toFixed(3)} TND</span></div>):<p>Aucun mouvement à risque détecté.</p>}</article>
          </section>}
        </div>
        <aside className={styles.reportFilters}>
          <div className={styles.filterHeading}><span>⌁</span><div><h3>Filtres d’analyse</h3><small>{activeFilters ? `${activeFilters} filtre(s) actif(s)` : "Périmètre global"}</small></div></div>
          <label>
            Période
            <select value={period} onChange={event=>setPeriod(event.target.value)}><option value="CURRENT_MONTH">Mois en cours</option><option value="LAST_90_DAYS">90 derniers jours</option><option value="LAST_12_MONTHS">12 derniers mois</option><option value="ALL">Toutes les données</option></select>
          </label>
          <label>
            Société
            <select
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            >
              <option>Toutes</option>
              {companies.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            Bénéficiaire
            <select
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
            >
              <option>Tous</option>
              {beneficiaries.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            Département
            <select value={department} onChange={event=>setDepartment(event.target.value)}>
              <option>Tous</option>{departments.map(value=><option key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            Responsable de carte
            <select value={responsible} onChange={event=>setResponsible(event.target.value)}><option>Tous</option>{responsibles.map(value=><option key={value}>{value}</option>)}</select>
          </label>
          <label>
            Véhicule
            <select value={vehicle} onChange={event=>setVehicle(event.target.value)}><option>Tous</option>{vehicleOptions.map(value=><option key={value}>{value}</option>)}</select>
          </label>
          <label>
            Produit
            <select value={product} onChange={event=>setProduct(event.target.value)}><option>Tous</option>{products.map(value=><option key={value}>{value}</option>)}</select>
          </label>
          <label>
            Station
            <select value={station} onChange={event=>setStation(event.target.value)}><option>Toutes</option>{stations.map(value=><option key={value}>{value}</option>)}</select>
          </label>
          <label>
            Statut
            <select value={cardStatus} onChange={event=>setCardStatus(event.target.value)}>
              <option>Tous</option>{statusOptions.map(value=><option value={value} key={value}>{status(value)}</option>)}
            </select>
          </label>
          <button
            onClick={() => {
              setCompany("Toutes");
              setBeneficiary("Tous");
              setDepartment("Tous");
              setCardStatus("Tous");
              setResponsible("Tous");
              setVehicle("Tous");
              setProduct("Tous");
              setStation("Toutes");
              setPeriod("CURRENT_MONTH");
            }}
          >
            Effacer les filtres
          </button>
        </aside>
      </div>
    </section>
  );
}
function transactionDay(value:unknown){
  const raw=String(value??"").trim();
  const french=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(french)return `${french[3]}-${french[2].padStart(2,"0")}-${french[1].padStart(2,"0")}`;
  const parsed=new Date(raw);
  if(Number.isNaN(parsed.getTime()))return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth()+1).padStart(2,"0")}-${String(parsed.getDate()).padStart(2,"0")}`;
}
function DailyConsumptionHistogram({transactions}:{transactions:Row[]}){
  const daily=Object.values(transactions.reduce<Record<string,{key:string;liters:number;amount:number;count:number}>>((days,row)=>{
    const key=transactionDay(row.date); if(!key)return days;
    const item=days[key]??{key,liters:0,amount:0,count:0};
    item.liters+=parseNumeric(row.litres); item.amount+=parseNumeric(row.montant); item.count+=1; days[key]=item;
    return days;
  },{})).sort((a,b)=>a.key.localeCompare(b.key));
  const maxLiters=Math.max(1,...daily.map(item=>item.liters));
  const maxAmount=Math.max(1,...daily.map(item=>item.amount));
  const totalLiters=daily.reduce((sum,item)=>sum+item.liters,0);
  const totalAmount=daily.reduce((sum,item)=>sum+item.amount,0);
  const formatDay=(key:string)=>new Date(`${key}T12:00:00`).toLocaleDateString("fr-FR",{day:"2-digit",month:"short"}).replace(".","");
  return <section className={styles.dailyConsumptionPanel}>
    <div className={styles.dailyConsumptionHead}>
      <div><small>RYTHME DE CONSOMMATION</small><h3>Consommation quotidienne</h3><p>Litres et montant facturé par jour · données Total Mobility</p></div>
      <div className={styles.dailyTotals}>
        <span><i className={styles.litersDot}/><small>Volume</small><b>{totalLiters.toLocaleString("fr-FR",{maximumFractionDigits:3})} L</b></span>
        <span><i className={styles.amountDot}/><small>Montant</small><b>{totalAmount.toLocaleString("fr-FR",{maximumFractionDigits:3})} TND</b></span>
      </div>
    </div>
    {daily.length?<div className={styles.dailyHistogram} role="img" aria-label="Histogramme de la consommation quotidienne en litres et en dinars">
      <div className={styles.dailyGridLines}><i/><i/><i/><i/></div>
      <div className={styles.dailyColumns}>{daily.map(item=><div className={styles.dailyColumn} key={item.key} title={`${formatDay(item.key)} · ${item.liters.toFixed(3)} L · ${item.amount.toFixed(3)} TND · ${item.count} transaction(s)`}>
        <div className={styles.dailyValues}><span>{item.liters.toLocaleString("fr-FR",{maximumFractionDigits:1})} L</span><span>{item.amount.toLocaleString("fr-FR",{maximumFractionDigits:1})} DT</span></div>
        <div className={styles.dailyBarPair}>
          <i className={styles.dailyLitersBar} style={{height:`${Math.max(3,item.liters/maxLiters*100)}%`}}/>
          <i className={styles.dailyAmountBar} style={{height:`${Math.max(3,item.amount/maxAmount*100)}%`}}/>
        </div>
        <b>{formatDay(item.key)}</b><small>{item.count} trx</small>
      </div>)}</div>
    </div>:<div className={styles.dailyHistogramEmpty}><AppIcon name="transactions" size={25}/><b>Aucune consommation quotidienne disponible</b><span>Le graphique apparaîtra après la prochaine extraction Total.</span></div>}
  </section>;
}
function ReportKpi({
  label,
  value,
  meta,
  tone = "default",
}: {
  label: string;
  value: string | number;
  meta?: string;
  tone?: "default" | "money" | "volume" | "good" | "warning" | "danger";
}) {
  return (
    <article className={`${styles.reportKpiCard} ${styles[`reportKpi_${tone}`]}`}>
      <span className={styles.reportKpiIcon} aria-hidden="true">
        {tone === "money" ? "↗" : tone === "volume" ? "◒" : tone === "good" ? "✓" : tone === "danger" ? "!" : tone === "warning" ? "⚠" : "◆"}
      </span>
      <small>{label}</small>
      <strong>{value}</strong>
      {meta && <em>{meta}</em>}
    </article>
  );
}
function Bars({ items,unit="L" }: { items: { name: string; value: number }[];unit?:string }) {
  const max = Math.max(1, ...items.map((x) => x.value));
  return (
    <div className={styles.bars}>
      {items.map((x) => (
        <div key={x.name}>
          <span>{x.name}</span>
          <i>
            <b style={{ width: `${(x.value / max) * 100}%` }} />
          </i>
          <em>{x.value.toFixed(0)} {unit}</em>
        </div>
      ))}
    </div>
  );
}
function printOfficialDocument(title:string,body:string){
  const popup=window.open("","_blank","width=1100,height=800");if(!popup)return;
  popup.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title><style>
  :root{--green:#087a55;--green-dark:#075f45;--green-soft:#eaf6f1;--ink:#172b3a;--muted:#667781;--line:#dbe5e1;--paper:#fff}
  *{box-sizing:border-box} @page{size:A4 landscape;margin:11mm 10mm 14mm} body{font-family:Inter,"Segoe UI",Arial,sans-serif;color:var(--ink);background:#eef3f1;margin:0;font-size:11px;line-height:1.45}.sheet{max-width:1120px;margin:24px auto;background:var(--paper);padding:34px 38px;box-shadow:0 12px 40px #183d2d1a}
  header{display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:2px solid var(--green);padding-bottom:16px;margin-bottom:18px}.brand{display:flex;align-items:center;gap:16px}.brand img{width:72px;height:72px;object-fit:contain}.brand h1{margin:0;color:var(--green-dark);font-size:24px;letter-spacing:-.4px}.brand p{margin:3px 0 0;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1.1px}.document-title{text-align:right}.document-title strong{display:block;font-size:20px;color:var(--ink)}.document-title span{display:inline-block;margin-top:5px;padding:4px 10px;border-radius:20px;background:var(--green-soft);color:var(--green-dark);font-weight:700;font-size:9px;letter-spacing:.8px;text-transform:uppercase}
  .meta{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:16px 0}.meta div{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:#fbfdfc;min-height:58px}.meta b{display:block;margin-bottom:4px;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.7px}.meta br{display:none}
  .summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0 18px}.summary div{border-radius:9px;padding:12px 14px;background:var(--green-soft);border-left:4px solid var(--green)}.summary span{display:block;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.7px}.summary strong{display:block;margin-top:2px;color:var(--green-dark);font-size:18px}
  table{width:100%;border-collapse:separate;border-spacing:0;font-size:8.5px;border:1px solid var(--line);border-radius:8px;overflow:hidden}thead{display:table-header-group}th{background:var(--green-dark);color:#fff;text-transform:uppercase;letter-spacing:.35px;font-size:7.5px;padding:8px 6px;text-align:left}td{padding:7px 6px;border-bottom:1px solid #e8efec;vertical-align:top}tbody tr:nth-child(even){background:#f6faf8}tbody tr:last-child td{border-bottom:0}th.numeric,td.numeric{text-align:right;white-space:nowrap}tr{break-inside:avoid}
  .total{font-size:16px;text-align:right;margin:16px 0 0;padding:12px 15px;color:var(--green-dark);background:var(--green-soft);border-radius:8px}.signatures{display:flex;justify-content:space-between;gap:5%;margin-top:65px}.signatures div{flex:1;min-width:0;border-top:1px solid #52645c;padding-top:8px;text-align:center;color:var(--muted)}.signatures b{display:block;margin-top:5px;color:var(--ink)}.notice{margin:14px 0 0;padding:9px 12px;border-left:3px solid #b8c9c2;background:#f5f8f7;font-size:8.5px;color:var(--muted)}footer{display:flex;justify-content:space-between;gap:20px;margin-top:15px;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font-size:8px}.print-action{display:block;margin:20px auto 0;border:0;border-radius:8px;background:var(--green);color:#fff;padding:11px 18px;font-weight:700;cursor:pointer}
  @media print{body{background:#fff}.sheet{max-width:none;margin:0;padding:0;box-shadow:none}.print-action{display:none}footer{position:fixed;bottom:-9mm;left:0;right:0}.page-number:after{content:"Page " counter(page)}}
  </style></head><body><main class="sheet"><header><div class="brand"><img src="/brand/delta-logo.png" alt="Delta Carburant"><div><h1>Delta Carburant</h1><p>Gestion et suivi des consommations</p></div></div><div class="document-title"><strong>${title}</strong><span>Document contrôlé</span></div></header>${body}<footer><span>Delta Carburant · Document généré automatiquement</span><span class="page-number">Édition du ${new Date().toLocaleDateString('fr-FR')}</span></footer><button class="print-action" onclick="window.print()">Imprimer / Enregistrer en PDF</button></main><script>window.onload=()=>setTimeout(()=>window.print(),350)</script></body></html>`);popup.document.close();
}
const documentText=(value:unknown)=>String(value??"—").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]??char));
function ComplaintsView({token,user,rows,refresh,notify}:{token:string;user:User;rows:Row[];refresh:()=>void;notify:(message:string)=>void}){
 const create=async()=>{const subject=window.prompt("Objet de la réclamation");if(!subject)return;const description=window.prompt("Description détaillée");if(!description)return;const available=["NAJIB_ASSIGNER","ZIN_FINANCE","DIRECTION_GENERAL"].filter(role=>role!==user.role);const targetRole=window.prompt(`Destinataire : ${available.join(" / ")}`,available[0]);if(!targetRole||!available.includes(targetRole))return notify("Destinataire invalide");const priority=window.prompt("Priorité : NORMAL / HIGH / URGENT","NORMAL")?.toUpperCase();if(!priority||!["NORMAL","HIGH","URGENT"].includes(priority))return notify("Priorité invalide");const response=await fetch(`${API}/complaints`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({subject,description,targetRole,priority})});if(!response.ok)return notify("La réclamation n’a pas été enregistrée");notify("Réclamation transmise");refresh();};
 const respond=async(row:Row)=>{const message=window.prompt(`Réponse à ${row.numero}`);if(!message)return;const response=await fetch(`${API}/complaints/${row.id}/messages`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({message})});if(!response.ok)return notify("Réponse non enregistrée");refresh();};
 const resolve=async(row:Row)=>{const resolution=window.prompt("Solution apportée à la réclamation");if(!resolution)return;const response=await fetch(`${API}/complaints/${row.id}/status`,{method:"PATCH",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({status:"RESOLVED",resolution})});if(!response.ok)return notify("Clôture impossible");notify("Réclamation résolue");refresh();};
 return <section className={styles.fullPanel}><div className={styles.importNotice}><b>Canal interne officiel</b><span>Najib, Zin et la DG peuvent ouvrir une réclamation, répondre, suivre son traitement et conserver la résolution dans l’historique.</span></div><Toolbar search="" setSearch={()=>{}} count={rows.length} button="Nouvelle réclamation" click={create}/><div className={styles.tableWrap}><table><thead><tr>{["N°","Date","Créateur","Destinataire","Objet","Priorité","Statut","Résolution","Action"].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.id}><td>{row.numero}</td><td>{row.date}</td><td>{row.createur}</td><td>{roleName[String(row.destinataire)]??row.destinataire}</td><td><b>{row.objet}</b><br/><small>{row.description}</small></td><td>{row.priorite}</td><td>{row.statut}</td><td>{row.resolution}</td><td><button className={styles.smallBtn} onClick={()=>respond(row)}>Répondre</button>{!['RESOLVED','CLOSED'].includes(String(row.statut))&&<><br/><button className={styles.smallBtn} onClick={()=>resolve(row)}>Résoudre</button></>}</td></tr>)}</tbody></table></div></section>;
}
function CardReturnsView({token,user,cards,requests,receipts,decide,refresh,notify}:{token:string;user:User;cards:Card[];requests:Row[];receipts:Row[];decide:(id:string,accepted:boolean)=>void|Promise<void>;refresh:()=>void;notify:(message:string)=>void}){
 const [clock,setClock]=useState(Date.now());
 useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
 const currentMonthKey=new Date().toISOString().slice(0,7);
 // Toute carte distribuée doit revenir au coffre une fois par mois, quel que
 // soit le rôle de son responsable (Najib, Zin, DG ou autre utilisateur).
 const eligible=cards.filter(card=>
   (["ACTIVE","DISTRIBUTED","ASSIGNED"].includes(card.status)&&Boolean(card.responsible_user_id))||
   receipts.some(receipt=>receipt.carte===card.masked_card_number)
 );
 const pendingFor=(card:Card)=>requests.find(row=>row.type==='Mise en coffre'&&row.carte===card.masked_card_number&&row.statut==='EN_ATTENTE_ZIN');
 const receiptFor=(card:Card)=>receipts.find(row=>row.carte===card.masked_card_number&&row.moisCle===currentMonthKey);
 const returnCard=async(card:Card)=>{if(pendingFor(card))return notify("Une demande de restitution est déjà en cours");if(card.responsible_user_id!==user.id)return notify("Seul le responsable actuel peut restituer cette carte");const response=await fetch(`${API}/requests`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requestType:'CUSTODY_CHANGE',requestedCardStatus:'SAFE',fuelCardId:card.id,responsibleUserId:card.responsible_user_id,beneficiary:card.beneficiary||user.name,department:card.department||'Hors parc',vehicle:card.registration||'Sans véhicule',requestedLimit:0,reason:'Restitution mensuelle obligatoire de la carte distribuée'})});if(!response.ok){const body=await response.json().catch(()=>({}));return notify(String(body.message??"La demande de restitution n’a pas été enregistrée"));}notify("Demande de restitution envoyée à Zin et à la DG");refresh();};
 const forceReturn=async(card:Card)=>{const reason=window.prompt(`Motif de l’ordre obligatoire de restitution de la carte ${card.masked_card_number}`,'Ordre de la Direction Générale');if(!reason)return;const response=await fetch(`${API}/requests/cards/${card.id}/force-return`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({reason})});const body=await response.json().catch(()=>({}));if(!response.ok)return notify(String(body.message??"L’ordre de restitution n’a pas été créé"));notify("Ordre obligatoire envoyé au responsable. Votre validation DG est déjà enregistrée.");refresh();};
 const restoreCard=async(receipt:Row)=>{if(!window.confirm(`Restaurer la même carte ${receipt.carte} à Najib avec son plafond actuel de ${Number(receipt.plafondActuel??0).toFixed(3)} TND ?`))return;const response=await fetch(`${API}/documents/return-receipts/${receipt.id}/restore`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});const body=await response.json().catch(()=>({}));if(!response.ok)return notify(String(body.message??"La carte n’a pas pu être restaurée"));notify("La même carte a été restaurée à Najib, sans création d’une nouvelle carte");refresh();};
 const signHandover=async(request:Row)=>{if(!window.confirm("Confirmer la remise physique de la carte à Zin et signer la restitution ?"))return;const response=await fetch(`${API}/requests/${request.id}/handover`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`}});const body=await response.json().catch(()=>({}));if(!response.ok)return notify(String(body.message??"La remise n’a pas pu être signée"));notify("Carte remise : le reçu signé par le responsable et Zin est disponible");refresh();};
 const countdown=(value:unknown)=>{const remaining=Math.max(0,new Date(String(value)).getTime()-clock),seconds=Math.floor(remaining/1000);return `${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor((seconds%3600)/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;};
 const printReceipt=(row:Row)=>printOfficialDocument(`Reçu de restitution ${documentText(row.numero)}`,`<div class="meta"><div><b>N° reçu</b>${documentText(row.numero)}</div><div><b>N° carte</b>${documentText(row.carte)}</div><div><b>Date de restitution</b>${documentText(row.date)}</div><div><b>Heure de restitution</b>${documentText(row.heure)}</div></div><div class="summary"><div><span>Plafond mensuel</span><strong>${Number(row.plafond??0).toFixed(3)} TND</strong></div><div><span>Consommation contrôlée</span><strong>${Number(row.consomme??0).toFixed(3)} TND</strong></div><div><span>Taux du plafond</span><strong>${Number(row.taux).toFixed(1)} %</strong></div></div><div class="meta"><div><b>Volume consommé</b>${Number(row.litres??0).toFixed(3)} litres</div><div><b>Transactions du mois</b>${Number(row.transactions??0)}</div><div><b>Mois de consommation</b>${documentText(row.mois)}</div><div><b>Statut</b>Restitution validée</div></div><p>Delta Carburant certifie la restitution physique mensuelle de cette carte. Le reçu porte uniquement les signatures de Najib / du responsable remettant et de Zin réceptionnaire.</p><div class="signatures"><div>Signature Najib / responsable<br><b>${documentText(row.restituePar)}</b></div><div>Signature Zin<br><b>${documentText(row.recuPar)}</b></div></div>`);
 const rows=[...eligible];for(const receipt of receipts)if(!rows.some(card=>card.masked_card_number===receipt.carte))rows.push({id:`receipt-${receipt.id}`,masked_card_number:String(receipt.carte),company_code:'DC',beneficiary:null,registration:null,monthly_limit:0,status:'SAFE',finance_status:'CONFIRMED',created_at:'',updated_at:'',card_category:'OFF_PARK',consumption_rate:Number(receipt.taux)});
 return <section className={styles.fullPanel}><div className={styles.importNotice}><b>Récupération mensuelle et conformité Total</b><span>Après validation avec le responsable, Zin ou la DG reçoit la carte et la met au coffre. Une action « Désactiver » reste alors ouverte jusqu’à confirmation du même statut dans « Gérer les cartes » sur Total Mobility.</span></div><div className={styles.tableWrap}><table><thead><tr>{["Carte","Plafond mensuel","Consommation du mois","Utilisation","Responsable / délai","Validation Zin","Validation DG","Reçu PDF","Statut","Action"].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(card=>{const request=pendingFor(card),receipt=receiptFor(card);const zinDone=request?.zinValide==='Oui',dgDone=request?.dgValide==='Oui',awaitingHandover=Boolean(request&&zinDone&&dgDone&&request.remiseEcheance&&request.remiseSignee!=='Oui'&&request.remiseExpiree!=='Oui');const alreadyApproved=(user.role==='ZIN_FINANCE'&&zinDone)||(user.role==='DIRECTION_GENERAL'&&dgDone);const ownsCard=card.responsible_user_id===user.id;const canReceive=awaitingHandover&&['ZIN_FINANCE','DIRECTION_GENERAL'].includes(user.role);const limit=Number(receipt?.plafond??card.monthly_limit??0),currentLimit=Number(receipt?.plafondActuel??card.monthly_limit??0),consumed=Number(receipt?.consomme??card.consumed_amount??0),canRestore=receipt&&!receipt.restaureeLe&&['ZIN_FINANCE','DIRECTION_GENERAL'].includes(user.role);return <tr key={card.id}><td><b>{card.masked_card_number}</b><small>{card.beneficiary||receipt?.restituePar||'—'} · {card.registration||'—'}</small></td><td><b>{limit.toFixed(3)} TND</b>{receipt&&currentLimit!==limit&&<small>Nouveau plafond : {currentLimit.toFixed(3)} TND</small>}</td><td><b>{consumed.toFixed(3)} TND</b><small>{receipt?`${Number(receipt.litres??0).toFixed(3)} L · ${Number(receipt.transactions??0)} transaction(s)`:"Mois courant"}</small></td><td><span className={styles.documentPending}>{Number(card.consumption_rate??receipt?.taux??0).toFixed(1)} %</span></td><td>{receipt?'✓ Remise signée':awaitingHandover?<><b>{countdown(request?.remiseEcheance)}</b><small>pour remettre à Zin / DG</small></>:request?.remiseExpiree==='Oui'?'Délai expiré':request?'✓ Demandée':'À récupérer ce mois'}</td><td>{receipt||zinDone?'✓ Validée':'○ En attente'}</td><td>{receipt||dgDone?'✓ Validée':'○ En attente'}</td><td>{receipt?<button className={styles.documentPrintBtn} onClick={()=>printReceipt(receipt)}>▣ Télécharger le reçu</button>:<span className={styles.waitingStatus}>{awaitingHandover?'Après réception par Zin / DG':'Après validations et remise'}</span>}</td><td>{receipt?.restaureeLe?<span className={styles.documentAuthorized}>✓ Redistribuée</span>:receipt?<span className={styles.documentAuthorized}>✓ Au coffre · désactivation Total à contrôler</span>:awaitingHandover?<span className={styles.documentPending}>Remise physique attendue</span>:request?<span className={styles.documentPending}>Validation en cours</span>:<span className={styles.documentPending}>Restitution mensuelle requise</span>}</td><td>{receipt?<>{canRestore&&<button className={styles.documentApproveBtn} onClick={()=>restoreCard(receipt)}>↻ Redistribuer la carte</button>}{receipt.restaureeLe&&<small>Par {receipt.restaureePar} · {receipt.restaureeLe}</small>}</>:canReceive?<button className={styles.documentApproveBtn} onClick={()=>signHandover(request!)}>Recevoir et mettre au coffre</button>:awaitingHandover&&ownsCard?<span className={styles.waitingStatus}>Remettez la carte à Zin / DG</span>:ownsCard&&!request?<button className={styles.documentApproveBtn} onClick={()=>returnCard(card)}>Restituer ma carte</button>:user.role==='DIRECTION_GENERAL'&&!request?<button className={styles.documentApproveBtn} onClick={()=>forceReturn(card)}>Ordonner la restitution</button>:request&&!alreadyApproved&&!awaitingHandover&&['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'].includes(user.role)?<button className={styles.documentApproveBtn} onClick={()=>decide(String(request.id),true)}>✓ Approuver</button>:<span className={styles.waitingStatus}>{alreadyApproved?'Votre validation est enregistrée':'En attente du responsable'}</span>}</td></tr>})}{!rows.length&&<tr><td colSpan={10}><div className={styles.documentEmpty}>Aucune carte distribuée à récupérer ce mois.</div></td></tr>}</tbody></table></div></section>;
}
function DocumentsView({token,notify}:{token:string;notify:(message:string)=>void}){
 const [period,setPeriod]=useState<'WEEK'|'MONTH'>('WEEK');const [start,setStart]=useState(new Date().toISOString().slice(0,10));const [busy,setBusy]=useState(false);
 const invoice=async()=>{setBusy(true);try{const response=await fetch(`${API}/documents/statement?period=${period}&start=${start}`,{headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw new Error();const doc=await response.json() as Record<string,unknown>;const transactions=(doc.transactions??[]) as Record<string,unknown>[];const money=(value:unknown)=>Number(value).toLocaleString('fr-FR',{minimumFractionDigits:3,maximumFractionDigits:3});const html=`<div class="meta"><div><b>N° de facture</b>${documentText(doc.documentNumber)}</div><div><b>Période de facturation</b>${documentText(new Date(String(doc.startDate)).toLocaleDateString('fr-FR'))} — ${documentText(new Date(String(doc.endDate)).toLocaleDateString('fr-FR'))}</div><div><b>Source des données</b>${documentText(doc.source)}</div><div><b>Date d’émission</b>${new Date().toLocaleDateString('fr-FR')}</div></div><div class="summary"><div><span>Transactions contrôlées</span><strong>${Number(doc.totalTransactions).toLocaleString('fr-FR')}</strong></div><div><span>Volume total</span><strong>${money(doc.totalLiters)} L</strong></div><div><span>Montant total TTC</span><strong>${money(doc.totalAmount)} TND</strong></div></div><table><thead><tr><th>Date et heure</th><th>Carte</th><th>Bénéficiaire</th><th>Véhicule</th><th>Station</th><th>Produit</th><th class="numeric">Litres</th><th class="numeric">Montant TND</th></tr></thead><tbody>${transactions.map(row=>`<tr><td>${documentText(new Date(String(row.date)).toLocaleString('fr-FR'))}</td><td>${documentText(row.card)}</td><td>${documentText(row.beneficiary)}</td><td>${documentText(row.vehicle)}</td><td>${documentText(row.station)}</td><td>${documentText(row.product)}</td><td class="numeric">${money(row.liters)}</td><td class="numeric"><b>${money(row.amount)}</b></td></tr>`).join('')}</tbody></table><p class="total">Total général TTC&nbsp;&nbsp; <b>${money(doc.totalAmount)} TND</b></p><p class="notice"><b>Note :</b> facture récapitulative interne établie à partir des transactions TotalEnergies importées. Les factures fiscales originales du fournisseur restent les pièces comptables de référence.</p>`;printOfficialDocument(period==='WEEK'?'Facture hebdomadaire':'Facture mensuelle',html);}catch{notify("Impossible de générer la facture");}finally{setBusy(false);}};
 return <section className={`${styles.fullPanel} ${styles.documentsPanel}`}><div className={styles.documentsHero}><div className={styles.documentsHeroIcon}>▤</div><div><small>RAPPROCHEMENT TOTAL</small><h2>Factures</h2><p>Générez les factures de rapprochement hebdomadaires ou mensuelles avec Total.</p></div></div><div className={styles.invoiceBuilder}><div className={styles.invoiceBuilderTitle}><span>01</span><div><b>Générer une facture</b><small>Aucune autorisation nécessaire : sélectionnez la période puis imprimez</small></div></div><label><span>Période</span><select value={period} onChange={e=>setPeriod(e.target.value as 'WEEK'|'MONTH')}><option value="WEEK">Hebdomadaire</option><option value="MONTH">Mensuelle</option></select></label><label><span>Date de référence</span><input type="date" value={start} onChange={e=>setStart(e.target.value)}/></label><button onClick={invoice} disabled={busy}><span>{busy?'◌':'▣'}</span>{busy?'Génération en cours…':'Générer et imprimer'}</button></div></section>;
}
function DataView({
  view,
  cards,
  data,
  user,
  search,
  setSearch,
  open,
  edit,
  editTransaction,
  allocateConsumption,
  archiveTransaction,
  deleteRow,
  editVehicle,
  resolve,
  decideReview,
  decideMileage,
  decideAllocation,
  decideRequest,
  cancelRequest,
  archiveRequest,
  refreshFuelPrices,
  observeTransaction,
}: {
  view: View;
  cards: Card[];
  data: Record<string, Row[]>;
  user: User;
  search: string;
  setSearch: (s: string) => void;
  open: (m: Modal) => void;
  edit: (c: Card) => void;
  editTransaction: (row: Row) => void;
  allocateConsumption: (row: Row) => void;
  archiveTransaction: (row: Row) => void;
  deleteRow: (
    section: "transactions" | "vehicles" | "beneficiaries",
    id?: string,
  ) => void;
  editVehicle: (row: Row) => void;
  resolve: (id: string) => void;
  decideReview: (id:string,accepted:boolean)=>void;
  decideMileage:(id:string,accepted:boolean)=>void;
  decideAllocation:(id:string,accepted:boolean)=>void;
  decideRequest: (id: string, accepted: boolean) => void;
  cancelRequest: (id: string) => void;
  archiveRequest: (id: string) => void;
  refreshFuelPrices: () => void;
  observeTransaction: (row: Row) => void;
}) {
  const [selectedCompany,setSelectedCompany]=useState("Toutes");
  const [page,setPage]=useState(1);
  const [pageSize,setPageSize]=useState(10);
  const config: Record<
    string,
    { button: string; modal: Modal; cols: string[] }
  > = {
    cards: { button: "Nouvelle carte", modal: "card", cols: [] },
    beneficiaries: {
      button: "",
      modal: null,
      cols: ["nom", "service", "vehicule", "carte", "statut"],
    },
    vehicles: {
      button: "Nouveau véhicule",
      modal: "vehicle",
      cols: [
        "numero",
        "immatriculation",
        "type",
        "titulaire",
        "carte",
        "garde",
        "observation",
        "statut",
      ],
    },
    drivers:{button:"Nouveau chauffeur Total",modal:"driver",cols:["numeroClient","nomClient","numeroChauffeur","prenom","nom","codeChauffeur","vehicules","statut"]},
    fuelPrices:{button:"Nouveau prix",modal:"fuelPrice",cols:["societe","produit","ancienPrix","nouveauPrix","variation","date","auteur","source"]},
    transactions: {
      button: "Importer Excel Total",
      modal: "import",
      cols: [
        "date",
        "carte",
        "beneficiaire",
        "vehicule",
        "nomStation",
        "nomProduit",
        "litres",
        "montant",
        "prixApplique",
        "montantTheorique",
        "ecartFacturation",
        "controleFacturation",
        "typeCarte",
        "reparti",
        "detailRepartition",
        "observation",
        "statut",
        "fichier",
      ],
    },
    requests: {
      button: "Nouvelle demande",
      modal: "request",
      cols: [
        "numero",
        "dateDemande",
        "demandeur",
        "type",
        "beneficiaire",
        "departement",
        "voiture",
        "plafond",
        "carte",
        "carteSource",
        "raison",
        "statut",
        "motif",
        "dateDecision",
        "decideur",
        "suivi",
        "recu",
      ],
    },
    mileage:{button:"Nouveau relevé hebdomadaire",modal:"mileage",cols:["semaine","vehicule","detailsVehicule","precedent","kilometrage","distanceDetectee","litresPeriode","consommation100km","rapprochement","detailsTransactions","anomalie","statut","validateur"]},
    anomalies: {
      button: "Exporter",
      modal: null,
      cols: ["date", "type", "carte", "vehicule", "station", "produit", "litres", "montant", "gravite", "statut"],
    },
  };
  const c = config[view];
  if (view === "cards") {
    const visibleCards =
      user.role === "NAJIB_ASSIGNER"
        ? cards
        : cards;
    const companyChoices=[...new Set(visibleCards.map(x=>x.company_code).filter(Boolean))];
    const filtered = visibleCards.filter((x) =>
      (selectedCompany==="Toutes"||x.company_code===selectedCompany)&&Object.values(x).join(" ").toLowerCase().includes(search.toLowerCase()),
    );
    return (
      <section className={styles.fullPanel}>
        <Toolbar
          search={search}
          setSearch={(value)=>{setSearch(value);setPage(1)}}
          count={filtered.length}
          button={canCreate(user.role) ? c.button : ""}
          click={() => open("card")}
        />
        {canManage(user.role)&&<label className={styles.companyFilter}>Société <select value={selectedCompany} onChange={event=>setSelectedCompany(event.target.value)}><option>Toutes</option>{companyChoices.map(company=><option key={company}>{company}</option>)}</select></label>}
        <CardTable key={`${search}-${selectedCompany}`} cards={filtered} transactions={data.transactions} full user={user} edit={edit} />
      </section>
    );
  }
  const beneficiaryRows: Row[] = Array.from(
    cards.filter((card) => card.beneficiary).reduce((rows, card) => {
      const key = String(card.beneficiary).toLowerCase();
      const previous = rows.get(key);
      rows.set(key, {
        id: previous?.id ?? `beneficiary-${key}`,
        nom: String(card.beneficiary),
        service: String(card.department ?? "—"),
        vehicule: [previous?.vehicule, card.registration].filter(Boolean).join(", "),
        carte: [previous?.carte, card.masked_card_number].filter(Boolean).join(", "),
        statut: card.status === "ACTIVE" ? "Actif" : status(card.status),
      });
      return rows;
    }, new Map<string, Row>()).values(),
  );
  // La vue Véhicules est le référentiel actif renvoyé par /vehicles. Une carte
  // historique ne doit jamais recréer implicitement une ligne de véhicule.
  const vehicleRows: Row[] = data.vehicles.map((row) => {
      const linkedCard = cards.find(
        (card) =>
          String(card.registration).toLowerCase() ===
          String(row.immatriculation).toLowerCase(),
      );
      return {
        ...row,
        carte: row.carte ?? linkedCard?.masked_card_number ?? "—",
        statut: linkedCard
          ? linkedCard.status === "ACTIVE"
            ? "Actif · carte liée"
            : `${row.statut} · ${status(linkedCard.status)}`
          : row.statut,
      };
    });
  const transactionRows: Row[] = data.transactions.map((row) => {
    const card = cards.find((item) => item.masked_card_number === String(row.carte));
    const allocated = parseNumeric(row.montantReparti);
    const billingStatus=String(row.controleFacturation??"PRICE_UNAVAILABLE");
    return { ...row, nomStation: row.station || "—", nomProduit: row.produit || "—",
      prixApplique:typeof row.prixApplique==="number"?`${Number(row.prixApplique).toFixed(3)} TND/L`:"—",
      montantTheorique:typeof row.montantTheorique==="number"?`${Number(row.montantTheorique).toFixed(3)} TND`:"—",
      ecartFacturation:typeof row.ecartFacturation==="number"?`${Number(row.ecartFacturation).toFixed(3)} TND`:"—",
      controleFacturation:billingStatus==="BILLING_OK"?"✓ Facture correcte":billingStatus==="BILLING_MISMATCH"?"⚠ Écart détecté":"Tarif à renseigner",
      typeCarte: card?.card_category === "OFF_PARK" ? "Hors parc" : "Personnalisée", reparti: `${allocated.toFixed(3)} DT`, detailRepartition: row.repartition || "Non répartie" };
  });
  const sourceRows = view === "beneficiaries" ? beneficiaryRows : view === "vehicles" ? vehicleRows : view === "transactions" ? transactionRows : (data[view] ?? []);
  const companyChoices=[...new Set((view==="vehicles"?vehicleRows:cards.map(card=>({societe:card.company_code}))).map(row=>String(row.societe??"")).filter(Boolean))];
  const rows = sourceRows.filter((x) =>
    (view!=="vehicles"||selectedCompany==="Toutes"||String(x.societe)===selectedCompany)&&
    Object.values(x).join(" ").toLowerCase().includes(search.toLowerCase()),
  );
  const pageCount=Math.max(1,Math.ceil(rows.length/pageSize));
  const currentPage=Math.min(page,pageCount);
  const paginatedRows=rows.slice((currentPage-1)*pageSize,currentPage*pageSize);
  const button =
    view === "requests"
      ? user.role === "NAJIB_ASSIGNER"
        ? c.button
        : ""
      : view === "mileage"
        ? ["NAJIB_ASSIGNER","ZIN_FINANCE"].includes(user.role) ? c.button : ""
      : view === "transactions"
        ? canManage(user.role)
          ? c.button
          : ""
      : view === "vehicles"
          ? canManageFleet(user.role) ? c.button : ""
        : view === "drivers"
          ? canManageFleet(user.role) ? c.button : ""
        : view === "fuelPrices"
          ? canManage(user.role) ? c.button : ""
        : view === "beneficiaries"
          ? ""
          : c.button;
  return (
    <section className={styles.fullPanel}>
      {view === "transactions" && (
        <div className={styles.importNotice}>
          <b>Source officielle : plateforme TotalEnergies</b>
          <span>
            {canManage(user.role)
              ? "Zin et la Direction importent, corrigent ou suppriment. Toute correction conserve sa justification ; aucune validation manuelle."
              : "Chaque responsable répartit les montants détectés de ses cartes hors parc entre les bénéficiaires et véhicules. La transaction Total originale reste intacte."}
          </span>
        </div>
      )}
      {view === "transactions" && user.role === "NAJIB_ASSIGNER" && (() => {
        const ready = transactionRows.filter(row => !row.reviewId && !row.repartitionEnAttente && parseNumeric(row.montant) > parseNumeric(row.montantReparti)).length;
        const pending = transactionRows.filter(row => Boolean(row.repartitionEnAttente)).length;
        const completed = transactionRows.filter(row => !row.reviewId && parseNumeric(row.montant) > 0 && parseNumeric(row.montantReparti) >= parseNumeric(row.montant)).length;
        const corrections = transactionRows.filter(row => Boolean(row.reviewId)).length;
        return <div className={styles.transactionTracker}>
          <article><span>01</span><div><small>À répartir</small><strong>{ready}</strong></div></article>
          <article><span>02</span><div><small>En validation Zin / DG</small><strong>{pending}</strong></div></article>
          <article><span>03</span><div><small>Réparties</small><strong>{completed}</strong></div></article>
          <article><span>!</span><div><small>À corriger par Zin</small><strong>{corrections}</strong></div></article>
        </div>;
      })()}
      {view==="transactions"&&canManage(user.role)&&data.importHistory?.length>0&&<details className={styles.importHistory}>
        <summary>Journal sécurisé des imports Total · {data.importHistory.length} import(s)</summary>
        <div className={styles.tableWrap}><table><thead><tr>{["Date","Fichier","Auteur","Lignes","Importées","Doublons ignorés","À contrôler","Actives","Statut"].map(label=><th key={label}>{label}</th>)}</tr></thead>
          <tbody>{data.importHistory.slice(0,10).map(row=><tr key={row.id}><td>{row.date}</td><td>{row.fichier}</td><td>{row.auteur}</td><td>{row.lignes}</td><td>{row.importees}</td><td>{row.doublons}</td><td>{row.controle}</td><td>{row.actives}</td><td><span className={styles.badge}>{row.statut}</span></td></tr>)}</tbody>
        </table></div>
      </details>}
      {(view === "beneficiaries" || view === "vehicles" || view === "drivers") && (
        <div className={styles.importNotice}>
          <b>{view === "vehicles" ? "Référentiel du parc automobile" : view==="drivers"?"Chauffeurs par société":"Module alimenté automatiquement"}</b>
          <span>{view === "vehicles"
            ? canManageFleet(user.role)
              ? "Une ligne = un véhicule de référence + sa carte. “Sans matricule” désigne un véhicule personnalisé. La garde et la répartition des transactions restent deux opérations séparées."
              : "Référentiel officiel : véhicule, titulaire, carte et état de garde. Les chauffeurs restent gérés dans leur module dédié."
            : view==="drivers"?"Najib peut créer et gérer les chauffeurs DC afin de préparer les affectations aux véhicules."
            : "Les données proviennent des cartes confirmées et de leurs affectations. Aucun ajout manuel n’est nécessaire."}</span>
        </div>
      )}
      {view === "vehicles" && (() => {
        const safe = vehicleRows.filter(row => String(row.garde).startsWith("En coffre")).length;
        const distributed = vehicleRows.length-safe;
        const missing = vehicleRows.filter(row => Boolean(row.sansMatricule)).length;
        return <div className={styles.transactionTracker}>
          <article><span>01</span><div><small>Référentiel véhicules</small><strong>{vehicleRows.length}</strong></div></article>
          <article><span>02</span><div><small>Cartes distribuées</small><strong>{distributed}</strong></div></article>
          <article><span>03</span><div><small>Cartes en coffre</small><strong>{safe}</strong></div></article>
          <article><span>04</span><div><small>Sans matricule</small><strong>{missing}</strong></div></article>
        </div>;
      })()}
      <Toolbar
        search={search}
        setSearch={(value)=>{setSearch(value);setPage(1)}}
        count={rows.length}
        button={button}
        click={() => (c.modal ? open(c.modal) : download(rows, view))}
      />
      {view==="vehicles"&&canManageFleet(user.role)&&<label className={styles.companyFilter}>Société <select value={selectedCompany} onChange={event=>{setSelectedCompany(event.target.value);setPage(1)}}><option>Toutes</option>{companyChoices.map(company=><option key={company}>{company}</option>)}</select></label>}
      {view === "transactions" && canManage(user.role) && rows.length > 0 && (
        <div className={styles.bulkBar}>
          <span>{rows.length} transaction(s)</span>
          <button onClick={() => deleteRow("transactions")}>
            Supprimer toutes les transactions
          </button>
        </div>
      )}
      {view === "fuelPrices" && canManage(user.role) && (
        <div className={styles.bulkBar}>
          <span>Source officielle : Ministère tunisien de l’Énergie</span>
          <button onClick={refreshFuelPrices}>Actualiser les prix Tunisie</button>
        </div>
      )}
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              {c.cols.map((x) => (
                <th key={x}>{x === "nomStation" ? "NOM DE LA STATION / RÉGION" : x === "nomProduit" ? "NOM DE PRODUIT" : x === "prixApplique" ? "PRIX APPLIQUÉ / L" : x === "montantTheorique" ? "MONTANT THÉORIQUE" : x === "ecartFacturation" ? "ÉCART FACTURATION" : x === "controleFacturation" ? "CONTRÔLE FACTURE" : x.toUpperCase()}</th>
              ))}
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {paginatedRows.map((r) => (
              <tr key={r.id}>
                {c.cols.map((k) => (
                  <td key={k} className={k === "controleFacturation" ? (String(r[k]).startsWith("✓") ? styles.billingOk : String(r[k]).startsWith("⚠") ? styles.billingMismatch : styles.billingUnpriced) : undefined}>{view==="mileage"&&k==="detailsTransactions"?(()=>{let tx:Record<string,unknown>[]=[];try{tx=JSON.parse(String(r.detailsTransactions??"[]"));}catch{}return <details><summary>{tx.length} transaction(s)</summary><div style={{minWidth:520}}>{tx.length?tx.map((item,index)=><div key={String(item.id??index)} style={{padding:"7px 0",borderBottom:"1px solid #dbe5e1"}}><b>{frenchDate(item.date, true)} · {Number(item.liters??0).toFixed(3)} L</b><br/><small>Carte {String(item.card??"—")} · {String(item.station??"—")} · {String(item.product??"—")} · {Number(item.amount??0).toFixed(3)} TND · {String(item.beneficiary??"—")}</small></div>):<small>Aucune transaction entre les deux relevés.</small>}<p><b>Total utilisé dans le calcul : {Number(r.litresPeriode??0).toFixed(3)} litres</b></p></div></details>})():tableValue(r[k])}</td>
                ))}
                <td>
                  {view === "requests" &&
                  canManage(user.role) &&
                  r.statut === "EN_ATTENTE_ZIN" ? (
                    <>
                      <button
                        className={styles.smallBtn}
                        onClick={() => decideRequest(r.id, true)}
                      >
                        Accepter
                      </button>{" "}
                      <button
                        className={`${styles.smallBtn} ${styles.dangerBtn}`}
                        onClick={() => decideRequest(r.id, false)}
                      >
                        Refuser
                      </button>
                    </>
                  ) : view === "requests" &&
                    user.role === "NAJIB_ASSIGNER" &&
                    r.statut === "EN_ATTENTE_ZIN" ? (
                    <button
                      className={`${styles.smallBtn} ${styles.dangerBtn}`}
                      onClick={() => cancelRequest(r.id)}
                    >
                      Annuler la demande
                    </button>
                  ) : view === "requests" && user.role === "ZIN_FINANCE" ? (
                    <>
                      {r.statut === "VALIDEE_ZIN" && r.recu !== "—" && (
                        <><button className={styles.smallBtn} onClick={()=>printReceipt(r)}>Imprimer reçu PDF</button>{" "}</>
                      )}
                      <button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={()=>archiveRequest(r.id)}>
                        Archiver
                      </button>
                    </>
                  ) : view === "requests" && r.statut === "VALIDEE_ZIN" && r.recu !== "—" ? (
                    <button className={styles.smallBtn} onClick={()=>printReceipt(r)}>Imprimer reçu PDF</button>
                  ) : view === "anomalies" && r.kind === "REVIEW" ? (
                    <><button className={styles.smallBtn} onClick={()=>decideReview(r.id,true)}>Accepter</button>{" "}<button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={()=>decideReview(r.id,false)}>Refuser</button></>
                  ) : view === "anomalies" && r.statut !== "Résolue" && r.statut !== "Acceptée" && r.statut !== "Refusée" ? (
                    <button className={styles.smallBtn} onClick={() => resolve(r.id)}>Résoudre</button>
                  ) : view === "mileage" && canManage(user.role) && r.statut === "EN_ATTENTE_ZIN" ? (
                    <><button className={styles.smallBtn} onClick={()=>decideMileage(r.id,true)}>Valider</button>{" "}<button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={()=>decideMileage(r.id,false)}>Refuser</button></>
                  ) : view === "transactions" && r.reviewId ? (
                    canManage(user.role) ? <><button className={styles.smallBtn} onClick={()=>decideReview(String(r.reviewId),true)}>Accepter et créer/lier</button>{" "}<button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={()=>decideReview(String(r.reviewId),false)}>Déclarer inexistante</button></> : <span className={styles.waitingStatus}>À corriger par Zin / DG</span>
                  ) : view === "transactions" ? (
                    user.role === "NAJIB_ASSIGNER" ? (
                      <><button className={styles.smallBtn} onClick={() => allocateConsumption(r)}>Répartir</button>{" "}<button className={styles.smallBtn} onClick={()=>observeTransaction(r)}>Observation DG</button></>
                    ) : canManage(user.role) ? (
                      <>
                        {r.repartitionEnAttente&&<><button className={styles.smallBtn} onClick={()=>decideAllocation(String(r.repartitionEnAttente),true)}>Valider répartition</button>{" "}<button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={()=>decideAllocation(String(r.repartitionEnAttente),false)}>Refuser répartition</button>{" "}</>}
                        <button
                          className={styles.smallBtn}
                          onClick={() => editTransaction(r)}
                        >
                          Corriger
                        </button>{" "}
                        {user.role==="ZIN_FINANCE"&&<><button className={styles.smallBtn} onClick={()=>observeTransaction(r)}>Observation DG</button>{" "}</>}
                        <button className={styles.smallBtn} onClick={()=>archiveTransaction(r)}>Archiver</button>{" "}
                        <button
                          className={`${styles.smallBtn} ${styles.dangerBtn}`}
                          onClick={() => deleteRow("transactions", r.id)}
                        >
                          Supprimer
                        </button>
                      </>
                    ) : (
                      <span>Consultation</span>
                    )
                  ) : view === "vehicles" ? (
                    canManageFleet(user.role) && !String(r.id).startsWith("vehicle-card-") ? <>
                      <button className={styles.smallBtn} onClick={() => editVehicle(r)}>Modifier</button>{" "}
                      <button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={() => deleteRow("vehicles", r.id)}>Supprimer</button>
                    </> : <span>Consultation</span>
                  ) : view === "drivers" ? (
                    <span>{canManageFleet(user.role)?"Gestion autorisée — ajout disponible":"Consultation"}</span>
                  ) : view === "fuelPrices" ? (
                    <span>{canManage(user.role)?"Gestion centralisée Zin / DG":"Consultation"}</span>
                  ) : view === "beneficiaries" ? (
                    <span>Synchronisé depuis la carte</span>
                  ) : (
                    <span>Suivi</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={currentPage}
        pageSize={pageSize}
        total={rows.length}
        onPage={setPage}
        onPageSize={(size)=>{setPageSize(size);setPage(1)}}
      />
    </section>
  );
}
function printReceipt(row:Row){
  const popup=window.open("","_blank","width=850,height=1100"); if(!popup)return;
  const safe=(value:unknown)=>String(value??"—").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]??char));
  popup.document.write(`<!doctype html><html><head><title>${safe(row.recu)}</title><style>body{font-family:Arial,sans-serif;color:#14213d;padding:48px}header{border-bottom:3px solid #1f8f5f;padding-bottom:18px;margin-bottom:30px}h1{margin:0;color:#1f8f5f}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.box{border:1px solid #dce4e0;border-radius:8px;padding:14px}.sign{display:flex;justify-content:space-between;margin-top:70px}.sign div{width:42%;border-top:1px solid #333;padding-top:10px}@media print{button{display:none}}</style></head><body><header><h1>DeltaCarburant</h1><p>Reçu officiel d’attribution / validation</p></header><h2>${safe(row.recu)}</h2><div class="grid"><div class="box"><b>Demande</b><br>${safe(row.numero)}</div><div class="box"><b>Type</b><br>${safe(row.type)}</div><div class="box"><b>Responsable</b><br>${safe(row.beneficiaire)}</div><div class="box"><b>Société / service</b><br>${safe(row.departement)}</div><div class="box"><b>Carte</b><br>${safe(row.carte)}</div><div class="box"><b>Véhicule</b><br>${safe(row.voiture)}</div><div class="box"><b>Plafond</b><br>${safe(row.plafond)} TND</div><div class="box"><b>Décision</b><br>${safe(row.suivi)}</div></div><p><b>Motif / observation :</b> ${safe(row.motif)}</p><div class="sign"><div>Signature responsable</div><div>Validation Zin / Direction Générale</div></div><button onclick="window.print()">Imprimer / Enregistrer en PDF</button><script>window.onload=()=>window.print()</script></body></html>`);popup.document.close();
}
function Toolbar({
  search,
  setSearch,
  count,
  button,
  click,
}: {
  search: string;
  setSearch: (s: string) => void;
  count: number;
  button: string;
  click: () => void;
}) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.listTools}>
        <label className={styles.searchField}>
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Rechercher dans la liste"
            placeholder="Rechercher par carte, véhicule, bénéficiaire…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && <button type="button" aria-label="Effacer la recherche" onClick={() => setSearch("")}>×</button>}
        </label>
        <span className={styles.resultCount}><b>{count}</b> résultat{count === 1 ? "" : "s"}</span>
      </div>
      {button && <button onClick={click}>＋ {button}</button>}
    </div>
  );
}

function Pagination({page,pageSize,total,onPage,onPageSize}:{
  page:number;pageSize:number;total:number;onPage:(page:number)=>void;onPageSize:(size:number)=>void;
}){
  const pages=Math.max(1,Math.ceil(total/pageSize));
  const first=total===0?0:(page-1)*pageSize+1;
  const last=Math.min(total,page*pageSize);
  return <nav className={styles.pagination} aria-label="Pagination du tableau">
    <div className={styles.pageSizeControl}>
      <label htmlFor={`page-size-${pageSize}-${total}`}>Lignes par page</label>
      <select id={`page-size-${pageSize}-${total}`} value={pageSize} onChange={event=>onPageSize(Number(event.target.value))}>
        {[5,10,20,30,50].map(size=><option key={size} value={size}>{size}</option>)}
      </select>
      <span>{first}–{last} sur <b>{total}</b></span>
    </div>
    <div className={styles.pageButtons}>
      <button type="button" onClick={()=>onPage(1)} disabled={page<=1} aria-label="Première page">«</button>
      <button type="button" onClick={()=>onPage(page-1)} disabled={page<=1} aria-label="Page précédente">‹</button>
      <strong>Page {page} <span>sur {pages}</span></strong>
      <button type="button" onClick={()=>onPage(page+1)} disabled={page>=pages} aria-label="Page suivante">›</button>
      <button type="button" onClick={()=>onPage(pages)} disabled={page>=pages} aria-label="Dernière page">»</button>
    </div>
  </nav>;
}
function CardTable({
  cards,
  transactions,
  user,
  edit,
  full = false,
}: {
  cards: Card[];
  transactions: Row[];
  user: User;
  edit: (c: Card) => void;
  full?: boolean;
}) {
  const [page,setPage]=useState(1);
  const [pageSize,setPageSize]=useState(10);
  const pages=Math.max(1,Math.ceil(cards.length/pageSize));
  const currentPage=Math.min(page,pages);
  // Le tri est appliqué ici, avant la pagination, pour qu'il soit identique
  // dans « Vue d'ensemble » et dans la liste complète des cartes.
  const cardRate=(card:Card)=>card.monthly_limit>0
    ? Math.min(100,Math.max(0,Math.round(Number(card.consumed_amount??0)/card.monthly_limit*100)))
    : 0;
  const isClosed=(card:Card)=>["SAFE","SUSPENDED","OPPOSED","REPLACED"].includes(card.status);
  const orderedCards=[...cards].sort((a,b)=>{
    const aRate=cardRate(a),bRate=cardRate(b);
    const aReached=aRate>=100,bReached=bRate>=100;
    if(aReached!==bReached)return aReached?-1:1;
    if(aReached&&isClosed(a)!==isClosed(b))return isClosed(a)?-1:1;
    return bRate-aRate
      || Number(b.consumed_amount??0)-Number(a.consumed_amount??0)
      || a.masked_card_number.localeCompare(b.masked_card_number,"fr");
  });
  const visibleCards=orderedCards.slice((currentPage-1)*pageSize,currentPage*pageSize);
  const allocationDetails = (cardTransactions: Row[]) =>
    cardTransactions.flatMap((transaction) =>
      String(transaction.repartition ?? "")
        .split("|")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry, index) => {
          const parts = entry.split("—").map((part) => part.trim());
          return {
            id: `${transaction.id}-${index}`,
            beneficiary: parts[0] || "Bénéficiaire non précisé",
            vehicle: parts[1] || "Véhicule non précisé",
            amount: parseNumeric(parts.slice(2).join(" — ")),
            transactionDate: String(transaction.date ?? "—"),
          };
        }),
    );

  return (
    <div className={full ? "" : styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h2>{full ? "Toutes les cartes" : "Cartes récentes"}</h2>
          <p>{cards.length} résultat(s) · numéros complets · détails liés</p>
        </div>
      </div>
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              <th>CARTE / CRÉATION</th>
              <th>BÉNÉFICIAIRE / DÉPARTEMENT</th>
              <th>VÉHICULE</th>
              <th>ANCIENNE → NOUVELLE</th>
              <th>PLAFOND / CONSOMMATION TOTALE</th>
              <th>STATUT</th>
              <th>RESPONSABLE ACTUEL</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {visibleCards.map((c) => {
              const cardTransactions = transactions.filter(
                (row) => String(row.carte) === c.masked_card_number,
              );
              // Le plafond est mensuel : le cumul affiché doit donc provenir du
              // calcul mensuel de l'API, et non de toutes les lignes chargées.
              const consumed = Number(c.consumed_amount ?? 0);
              const totalConsumed = Number(c.total_consumed_amount ?? consumed);
              const allocations = allocationDetails(cardTransactions);
              const allocated = allocations.reduce((sum, item) => sum + item.amount, 0);
              const rate = cardRate(c);
              const isNajibLimitWarning = user.role === "NAJIB_ASSIGNER" && rate >= 60;
              const isLimitReached = rate >= 100;
              const previous = c.old_card_id ? cards.find((item) => item.id === c.old_card_id) : undefined;
              const previousConsumed = Number(previous?.consumed_amount ?? 0);
              const previousRate = previous?.monthly_limit ? Math.min(100, Math.round(previousConsumed / previous.monthly_limit * 100)) : 100;
              const locked = Boolean(c.activation_locked && previousRate < 100);
              return (
              <Fragment key={c.id}>
              <tr className={isNajibLimitWarning ? (isLimitReached ? styles.limitReachedRow : styles.limitWarningRow) : undefined}>
                <td>
                  <b>{c.masked_card_number}</b>
                  <small>
                    {c.company_code} · {c.card_category === "OFF_PARK" ? "Hors parc — responsable attribué" : "Personnalisée"} · créée le {c.created_at}
                  </small>
                </td>
                <td>
                  <b>{c.beneficiary ?? "Non affectée"}</b>
                  <small>{c.department ?? "—"}</small>
                </td>
                <td>
                  <b>{c.registration ?? "—"}</b>
                  <small>{c.vehicle_model ?? ""}</small>
                </td>
                <td>
                  {c.old_card_id
                    ? `${cards.find((x) => x.id === c.old_card_id)?.masked_card_number ?? "?"} → ${c.masked_card_number}`
                    : c.replacement_card_id
                      ? `${c.masked_card_number} → ${cards.find((x) => x.id === c.replacement_card_id)?.masked_card_number ?? "?"}`
                      : "—"}
                </td>
                <td>
                  <div className={`${styles.consumptionCell} ${isNajibLimitWarning ? styles.consumptionWarning : ""} ${isLimitReached ? styles.consumptionReached : ""}`}>
                    <div className={styles.consumptionTopline}>
                      <b>Plafond : {c.monthly_limit.toLocaleString("fr-FR")} TND</b>
                      <strong>{rate}%</strong>
                    </div>
                    <div
                      className={styles.consumptionTrack}
                      role="progressbar"
                      aria-label={`Consommation mensuelle de la carte ${c.masked_card_number}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={rate}
                    >
                      <span style={{ width: `${rate}%` }} />
                    </div>
                    <small>
                      Ce mois : <b>{consumed.toLocaleString("fr-FR")} TND</b>
                      {" · "}Solde : <b>{Math.max(0, c.monthly_limit-consumed).toLocaleString("fr-FR")} TND</b>
                      {" · "}Cumul : {totalConsumed.toLocaleString("fr-FR")} TND
                    </small>
                    {isNajibLimitWarning && (
                      <span className={styles.limitWarningBadge}>
                        <i aria-hidden="true">!</i>
                        {isLimitReached ? "Plafond atteint — carte à clôturer" : "Seuil 60 % dépassé — clôture prochaine"}
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <span
                    className={`${styles.badge} ${styles[c.status.toLowerCase()] ?? ""}`}
                  >
                    {status(c.status)}
                  </span>
                  <small>{financeStatus(c.finance_status)}</small>
                  {c.opposition_reason && <small>{c.opposition_reason}</small>}
                </td>
                <td>
                  <b>{c.responsible_name??"Non attribuée"}</b>
                  <small>{c.latest_action_type?`Dernière action : ${c.latest_action_type} · ${c.latest_action_responsible??"—"}`:"Aucune action tracée"}</small>
                </td>
                <td>
                  {user.role === "NAJIB_ASSIGNER" ? (
                    c.status === "TO_ASSIGN" && !locked ? (
                      <button
                        className={styles.smallBtn}
                        onClick={() => edit(c)}
                      >
                        Affecter
                      </button>
                    ) : (
                      <span>{locked ? `Verrouillée — ancienne carte à ${previousRate}%` : "En attente"}</span>
                    )
                  ) : (
                    <div className={styles.cardActionButtons}><button className={styles.smallBtn} onClick={() => edit(c)}>
                      {canConfirm(user.role) && c.finance_status === "PENDING"
                        ? "Vérifier"
                        : "Modifier"}
                    </button>{canManage(user.role)&&<button className={styles.smallBtn} onClick={()=>edit({...c,initial_action:"responsible"})}>Responsable</button>}</div>
                  )}
                </td>
              </tr>
              {user.role === "NAJIB_ASSIGNER" && c.card_category === "OFF_PARK" && (
                <tr className={styles.allocationRow}>
                  <td colSpan={8}>
                    <div className={styles.allocationDetails}>
                      <div className={styles.allocationSummary}>
                        <b>Détail de la répartition du responsable</b>
                        <span>
                          Détecté par Total : <strong>{consumed.toLocaleString("fr-FR")} TND</strong>
                          {" · "}Réparti : <strong>{allocated.toLocaleString("fr-FR")} TND</strong>
                          {" · "}Reste : <strong>{Math.max(0, consumed - allocated).toLocaleString("fr-FR")} TND</strong>
                        </span>
                      </div>
                      {allocations.length ? (
                        <div className={styles.allocationList}>
                          {allocations.map((allocation) => (
                            <div key={allocation.id}>
                              <span className={styles.allocationAvatar}>{allocation.beneficiary.charAt(0).toUpperCase()}</span>
                              <span><b>{allocation.beneficiary}</b><small>{allocation.vehicle} · transaction du {allocation.transactionDate}</small></span>
                              <strong>{allocation.amount.toLocaleString("fr-FR")} TND</strong>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className={styles.noAllocation}>Aucune consommation répartie pour cette carte.</p>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={currentPage} pageSize={pageSize} total={cards.length} onPage={setPage} onPageSize={(size)=>{setPageSize(size);setPage(1)}}/>
    </div>
  );
}
function ModalForm({
  type,
  card,
  cards,
  vehicles,
  responsibles,
  companies,
  editingRow,
  user,
  close,
  submit,
}: {
  type: Exclude<Modal, null>;
  card: Card | null;
  cards: Card[];
  vehicles: Row[];
  responsibles:{id:string;name:string;email:string}[];
  companies:{id:string;code:string;name:string}[];
  editingRow: { view: "beneficiaries" | "vehicles"; row: Row } | null;
  user: User;
  close: () => void;
  submit: (e: FormEvent<HTMLFormElement>) => void | Promise<void>;
}) {
  const selectableVehicles = vehicles.filter(
    (row) => String(row.immatriculation ?? "").trim() && String(row.immatriculation) !== "À COMPLÉTER",
  );
  const [requestType, setRequestType] = useState<"NEW_CARD" | "LIMIT_CHANGE" | "CARD_FUNDING" | "CUSTODY_CHANGE">("NEW_CARD");
  const [custodyTarget,setCustodyTarget]=useState<"SAFE"|"DISTRIBUTED">("DISTRIBUTED");
  const [requestCardId, setRequestCardId] = useState("");
  const requestCards = cards.filter((item) => requestType==="NEW_CARD"||requestType==="CARD_FUNDING" ? item.status==="SAFE" : requestType==="CUSTODY_CHANGE" ? (custodyTarget==="SAFE" ? item.status!=="SAFE" : item.status==="SAFE") : ["ACTIVE","TO_ASSIGN"].includes(item.status));
  const requestCard = requestCards.find((item) => item.id === requestCardId);
  const eligibleFundingSources=requestCards.filter(item=>item.status==="ACTIVE"&&item.id!==requestCardId&&Number(item.monthly_limit)>0&&Number(item.consumption_rate??0)>=60);
  const [action, setAction] = useState(
    card?.initial_action??(card && canAssign(user.role) && card.status === "TO_ASSIGN"
      ? "assign"
      : canManageCards(user.role)
        ? "editDetails"
        : "distributed"),
  );
  const editFields: [string, string, string?][] =
    editingRow?.view === "vehicles"
      ? [
          ["immatriculation", "Immatriculation"],
          ["type", "Type de véhicule"],
          ["societe", "Société"],
          ["mise_en_circulation", "Date de mise en circulation"],
          ["titulaire", "Titulaire carte grise"],
          ["echeance_credit", "Échéance crédit"],
          ["affectation", "Affectation"],
          ["reference", "Marque / référence"],
          ["conducteur", "Conducteur"],
          ["statut", "Statut"],
        ]
      : [
          ["nom", "Nom complet"],
          ["service", "Service"],
          ["carte", "Carte affectée"],
          ["statut", "Statut"],
        ];
  const fields: Record<string, [string, string, string?][]> = {
    card: [
      ["number", "Numéro de carte", "text"],
      ["limit", "Plafond mensuel", "number"],
    ],
    beneficiary: [
      ["nom", "Nom complet"],
      ["service", "Service"],
      ["carte", "Carte affectée"],
    ],
    vehicle: [
      ["immatriculation", "Immatriculation"],
      ["type", "Type de véhicule"],
      ["societe", "Société"],
      ["mise_en_circulation", "Date de mise en circulation"],
      ["titulaire", "Titulaire carte grise"],
      ["echeance_credit", "Échéance crédit"],
      ["affectation", "Affectation"],
      ["reference", "Marque / référence"],
      ["conducteur", "Conducteur"],
      ["statut", "Statut"],
    ],
    editRow: editFields,
    editTransaction: [],
    request: [],
    mileage: [],
    driver: [],
    fuelPrice: [],
    settings: [["societe", "Nom de la société"]],
    import: [["file", "Fichier Total Excel ou CSV (.xlsx, .xls, .csv)", "file"]],
  };
  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <form className={styles.modal} onSubmit={submit}>
        <div className={styles.modalHead}>
          <div>
            <h2>
              {type === "cardAction"
                ? `Carte ${card?.masked_card_number}`
                : titles[type]}
            </h2>
            <p>
              {type === "cardAction"
                ? `Créée le ${card!.created_at} · ${card!.beneficiary ?? "non affectée"} · ${card!.registration ?? "sans véhicule"}`
                : type === "import"
                  ? "Sélectionnez l’export Excel téléchargé depuis la plateforme Total."
                  : "Complétez les informations puis validez."}
            </p>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </div>
        {type === "cardAction" ? (
          <div className={styles.formGrid}>
            <label className={styles.fullField}>
              Action
              <select
                name="action"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              >
                {canAssign(user.role) && card?.status === "TO_ASSIGN" && (
                  <option value="assign">Affecter la carte</option>
                )}
                {canManageCards(user.role) && (
                  <>
                    <option value="editDetails">Modifier les informations</option>
                    <option value="distributed">
                      Marquer comme distribuée
                    </option>
                    <option value="LOST">Déclarer perdue</option>
                    <option value="STOLEN">Déclarer volée</option>
                    <option value="replace">Lier une carte remplaçante</option>
                  </>
                )}
                {canManage(user.role)&&<option value="responsible">Changer / transférer le responsable</option>}
                {canConfirm(user.role) && (
                  <>
                    <option value="oppose">Mettre en opposition</option>
                    <option value="confirm">Valider l’affectation</option>
                    <option value="reject">Refuser la validation</option>
                    <option value="block">Bloquer la carte</option>
                    <option value="unblock">Débloquer / réactiver</option>
                  </>
                )}
                {isDirection(user.role) && <option value="delete">Archiver la carte</option>}
              </select>
            </label>
            {action==="editDetails"&&(
              <>
                <label>Numéro de carte<input name="cardNumber" required defaultValue={card?.masked_card_number}/></label>
                <label>Bénéficiaire<input name="editBeneficiary" required defaultValue={card?.beneficiary??""}/></label>
                <label className={styles.fullField}>Plafond mensuel (TND)<input name="monthlyLimit" type="number" min="0" step="0.001" required defaultValue={card?.monthly_limit}/></label>
              </>
            )}
            {action === "assign" && (
              <>
                <label>
                  Bénéficiaire
                  <input name="beneficiary" required />
                </label>
                <label>
                  Véhicule / immatriculation
                  <select name="vehicleId" required defaultValue="">
                    <option value="" disabled>
                      Sélectionner un véhicule du parc
                    </option>
                    {selectableVehicles.map((vehicle) => (
                      <option
                        value={String(vehicle.id)}
                        key={String(vehicle.id)}
                      >
                        {String(vehicle.immatriculation)} · {String(vehicle.type)} · {String(vehicle.reference)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {action === "replace" && (
              <label className={styles.fullField}>
                Nouvelle carte
                <select name="replacementId" required defaultValue="">
                  <option value="" disabled>
                    Sélectionner une carte disponible
                  </option>
                  {cards
                    .filter(
                      (c) => c.id !== card?.id && c.status === "TO_ASSIGN",
                    )
                    .map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.masked_card_number} · créée le {c.created_at}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {action==="responsible"&&<><div className={styles.workflowInfo}><b>Responsable actuel</b><span>{responsibles.find(item=>item.id===card?.responsible_user_id)?.name??"Aucun responsable"}</span></div><label className={styles.fullField}>Nouveau responsable de la carte<select name="responsibleUserId" required defaultValue=""><option value="" disabled>Sélectionner un autre utilisateur</option>{responsibles.filter(item=>item.id!==card?.responsible_user_id).map(item=><option value={item.id} key={item.id}>{item.name} · {item.email}</option>)}</select></label></>}
            <label className={styles.fullField}>Responsable de cette action<select name="actionResponsibleUserId" required defaultValue=""><option value="" disabled>Sélectionner le responsable obligatoire</option>{responsibles.map(item=><option value={item.id} key={item.id}>{item.name} · {item.email}</option>)}</select></label>
            {["LOST", "STOLEN", "oppose", "replace"].includes(action) && (
              <label className={styles.fullField}>
                Motif / observation
                <textarea name="reason" required />
              </label>
            )}
            {!["LOST", "STOLEN", "oppose", "replace"].includes(action) && <label className={styles.fullField}>Observation de traçabilité (facultative)<textarea name="actionObservation" placeholder="Précision sur la distribution, restitution, alimentation ou autre action" /></label>}
            <div className={styles.workflowInfo}>
              <b>Règle appliquée</b>
              <span>
                {action === "editDetails"
                  ? "Le numéro, le bénéficiaire et le plafond sont modifiés dans la base et enregistrés dans le journal d’audit."
                  : action === "replace"
                  ? "Le bénéficiaire et le véhicule sont transférés. Les transactions restent sur la carte utilisée et sont agrégées dans le même cycle de vie."
                  : action === "assign"
                    ? "Le responsable affecte la carte, puis Zin Finance ou la DG confirme."
                    : action === "delete"
                      ? "Archivage logique uniquement : aucun historique financier n’est détruit."
                      : "Cette action est journalisée dans le processus."}
              </span>
            </div>
          </div>
        ) : (
          <div className={styles.formGrid}>
            {type === "request" && (
              <>
                <label className={styles.fullField}>
                  Type de demande
                  <select name="typeDemande" value={requestType} onChange={(event) => { setRequestType(event.target.value as "NEW_CARD" | "LIMIT_CHANGE" | "CARD_FUNDING" | "CUSTODY_CHANGE"); setRequestCardId(""); }}>
                    <option value="NEW_CARD">Demande de nouvelle carte</option>
                    <option value="CARD_FUNDING">Alimentation d’une carte disponible</option>
                    <option value="LIMIT_CHANGE">Demande d’augmentation de plafond</option>
                    <option value="CUSTODY_CHANGE">Changement coffre / distribution</option>
                  </select>
                </label>
                {requestType === "CUSTODY_CHANGE" && <label className={styles.fullField}>État demandé<select name="etatCarte" value={custodyTarget} onChange={event=>{setCustodyTarget(event.target.value as "SAFE"|"DISTRIBUTED");setRequestCardId("");}}><option value="DISTRIBUTED">Sortir du coffre et distribuer sous ma responsabilité</option><option value="SAFE">Remettre en coffre et retirer de ma responsabilité</option></select></label>}
                {requestType === "NEW_CARD" || requestType === "LIMIT_CHANGE" || requestType === "CARD_FUNDING" || requestType === "CUSTODY_CHANGE" ? (
                  <>
                    <label className={styles.fullField}>
                      {requestType === "NEW_CARD" ? "Nouvelle carte disponible en coffre" : requestType === "CARD_FUNDING" ? "Carte disponible en coffre à alimenter" : requestType==="CUSTODY_CHANGE"?(custodyTarget==="SAFE"?"Carte sous votre responsabilité":"Carte disponible en coffre"):"Carte disponible dans la base"}
                      <select name="carteId" required value={requestCardId} onChange={(event) => setRequestCardId(event.target.value)}>
                        <option value="" disabled>Sélectionner une carte active</option>
                        {requestCards.map((item) => <option value={item.id} key={item.id}>{item.masked_card_number} · plafond actuel {item.monthly_limit.toLocaleString("fr-FR")}</option>)}
                      </select>
                    </label>
                    {(requestType==="NEW_CARD"||requestType==="CARD_FUNDING")?<><label>Bénéficiaire<input name="beneficiaire" required /></label><label>Département<input name="departement" required /></label><label>Voiture / immatriculation<select name="voiture" required defaultValue=""><option value="" disabled>Sélectionner une matricule</option>{selectableVehicles.map(vehicle=><option value={String(vehicle.immatriculation)} key={String(vehicle.id)}>{String(vehicle.immatriculation)} · {String(vehicle.type)}</option>)}</select></label></>:<><input type="hidden" name="beneficiaire" value={requestCard?.beneficiary ?? "Najib"} /><input type="hidden" name="departement" value={requestCard?.department ?? "Hors parc"} /><input type="hidden" name="voiture" value={requestCard?.registration ?? "Sans véhicule"} /></>}
                    {requestCard && <div className={styles.workflowInfo}><b>Plafond actuel</b><span>{requestCard.monthly_limit.toLocaleString("fr-FR")}</span></div>}
                  </>
                ) : (
                  <>
                    <label>Bénéficiaire<input name="beneficiaire" required /></label>
                    <label>Département<input name="departement" required /></label>
                    <label>Voiture / immatriculation<select name="voiture" required defaultValue=""><option value="" disabled>Sélectionner une matricule</option>{selectableVehicles.map((vehicle) => <option value={String(vehicle.immatriculation)} key={String(vehicle.id)}>{String(vehicle.immatriculation)} · {String(vehicle.type)} · {String(vehicle.reference)}</option>)}</select></label>
                  </>
                )}
                {requestType!=="CUSTODY_CHANGE"?<label>Plafond demandé<input name="plafond" type="number" min={requestType === "LIMIT_CHANGE" ? (requestCard?.monthly_limit ?? 0) + 0.001 : 0} step="0.001" required /></label>:<input type="hidden" name="plafond" value="0"/>}
                <label className={styles.fullField}>Motif de la demande<input name="motif" required minLength={3} /></label>
                <label className={styles.fullField}>Responsable de l’alimentation / restitution / distribution<select name="responsableAction" required defaultValue=""><option value="" disabled>Sélectionner le responsable obligatoire</option>{responsibles.map(item=><option value={item.id} key={item.id}>{item.name} · {item.email}</option>)}</select></label>
              </>
            )}
            {fields[type].map((f) => (
              <label
                key={f[0]}
                className={type === "import" ? styles.fullField : undefined}
              >
                {f[1]}
                {type === "request" && f[0] === "voiture" ? (
                  <select name="voiture" required defaultValue="">
                    <option value="" disabled>
                      Sélectionner une matricule
                    </option>
                    {selectableVehicles.map((vehicle) => (
                      <option
                        value={String(vehicle.immatriculation)}
                        key={String(vehicle.id)}
                      >
                        {String(vehicle.immatriculation)} · {String(vehicle.type)} · {String(vehicle.reference)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    name={f[0]}
                    type={f[2] ?? "text"}
                    defaultValue={
                      type === "editRow"
                        ? String(editingRow?.row[f[0]] ?? "")
                        : undefined
                    }
                    accept={type === "import" ? ".xlsx,.xls,.csv,text/csv" : undefined}
                    required={
                      type === "vehicle" || (type === "editRow" && editingRow?.view === "vehicles")
                        ? ["immatriculation", "type", "societe"].includes(f[0])
                        : !(["beneficiary", "department", "registration", "vehicleModel"].includes(f[0]) && type === "card")
                    }
                  />
                )}
              </label>
            ))}
            {type === "mileage" && <><label className={styles.fullField}>{user.role==="ZIN_FINANCE"?"Véhicule actif du parc DC":"Véhicule de votre périmètre"}<select name="vehicleId" required defaultValue=""><option value="" disabled>Sélectionner un véhicule</option>{vehicles.map(vehicle=><option value={String(vehicle.id)} key={String(vehicle.id)}>{String(vehicle.immatriculation)} · dernier relevé {Number(vehicle.kilometrage??0).toLocaleString("fr-FR")} km</option>)}</select></label><label>Nouveau kilométrage<input name="mileage" type="number" min="0" step="0.1" required /></label><label>Observation<input name="note" /></label><div className={styles.workflowInfo}><b>Contrôle automatique</b><span>{user.role==="ZIN_FINANCE"?"La saisie Zin est validée immédiatement et notifiée à la DG. Tout écart génère une anomalie.":"Après la répartition, Najib saisit le kilométrage. Zin ou la DG contrôle ensuite le relevé et tout écart détecté."}</span></div></>}
            {type==="driver"&&<><label>Société<select name="companyId" required defaultValue=""><option value="" disabled>Sélectionner</option>{companies.map(item=><option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label><label>N° du client Total<input name="customerNumber" defaultValue="10391" required inputMode="numeric"/></label><label>Nom du client<input name="customerName" defaultValue="DELTA CUISINE" required/></label><label>Numéro de chauffeur<input name="driverNumber" placeholder="0005" required inputMode="numeric"/></label><label>Prénom<input name="firstName" required minLength={2}/></label><label>Nom<input name="lastName" required minLength={2}/></label><label>Code chauffeur Total<input name="driverCode" placeholder="0000" required inputMode="numeric"/></label><div className={styles.workflowInfo}><b>Référence TotalEnergies</b><span>Le numéro et le code chauffeur sont conservés sur 4 chiffres, y compris les zéros au début.</span></div></>}
            {type==="fuelPrice"&&<><label>Société<select name="companyId" required defaultValue=""><option value="" disabled>Sélectionner</option>{companies.map(item=><option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label><label>Produit<select name="product" required defaultValue=""><option value="" disabled>Sélectionner</option><option>ESSENCE SANS PLOMB</option><option>GASOIL ORDINAIRE</option><option>GASOIL SANS SOUFRE (GASOIL 50)</option><option>GASOIL PREMIUM / POWER</option><option>ESSENCE PREMIUM / POWER</option></select></label><label>Nouveau prix / litre (TND)<input name="newPrice" type="number" min="0.001" step="0.001" required/></label><label>Date d’effet<input name="effectiveDate" type="date"/></label><div className={styles.workflowInfo}><b>Prix en TND par litre</b><span>SSP EXC = Super Sans Plomb Excellium. GO SS EXC = Gasoil Sans Soufre Excellium. Ces produits premium sont contrôlés selon le tarif fournisseur Total.</span></div></>}
            {type==="card"&&<label className={styles.fullField}>Responsable de la carte<select name="responsibleUserId" required defaultValue=""><option value="" disabled>Sélectionner un responsable</option>{responsibles.map(item=><option value={item.id} key={item.id}>{item.name} · {item.email}</option>)}</select></label>}
            {type==="card"&&<label className={styles.fullField}>Société propriétaire<select name="companyId" required defaultValue=""><option value="" disabled>Sélectionner une société</option>{companies.map(item=><option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label>}
            {type === "card" && (
              <label className={styles.fullField}>
                Type de carte
                <select name="cardCategory" defaultValue="PERSONALIZED">
                  <option value="PERSONALIZED">Carte personnalisée — distribution par le responsable</option>
                  <option value="OFF_PARK">Carte hors parc — distribution par le responsable</option>
                </select>
              </label>
            )}
            {type === "import" && (
              <div className={styles.workflowInfo}>
                <b>Import sécurisé</b>
                <span>
                  Colonnes obligatoires : « Nom de produit » et « Nom de la station ».
                  Elles identifient le carburant consommé et la région de la transaction.
                  Les doublons du fichier Total seront détectés et ignorés.
                </span>
              </div>
            )}
          </div>
        )}
        <div className={styles.modalActions}>
          <button type="button" onClick={close}>
            Annuler
          </button>
          <button type="submit">
            {type === "import" ? "Importer le fichier" : "Enregistrer"}
          </button>
        </div>
      </form>
    </div>
  );
}
function Login({
  onSubmit,
  loading,
  error,
}: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  loading: boolean;
  error: string;
}) {
  const [email, setEmail] = useState("");
  const [showPassword,setShowPassword]=useState(false);
  const [activeFeature,setActiveFeature]=useState(0);
  const loginFeatures=[
    {icon:"cards" as const,title:"Cartes & plafonds",caption:"Maîtrise budgétaire",description:"Visualisez les consommations, plafonds disponibles et seuils d’utilisation depuis un même cockpit.",tag:"Contrôle en temps réel"},
    {icon:"vehicle" as const,title:"Parc automobile",caption:"Vue opérationnelle",description:"Suivez les véhicules, leurs affectations et leur activité avec une lecture immédiatement exploitable.",tag:"Parc centralisé"},
    {icon:"transactions" as const,title:"Transactions Total",caption:"Flux automatisé",description:"Centralisez les transactions Total Mobility et contrôlez chaque mouvement sans import manuel.",tag:"Synchronisation directe"},
    {icon:"alert" as const,title:"Alertes intelligentes",caption:"Pilotage des risques",description:"Identifiez rapidement les dépassements, écarts et opérations nécessitant une intervention.",tag:"Surveillance active"},
  ];
  useEffect(()=>{
    if(window.location.search) window.history.replaceState({},"",window.location.pathname);
  },[]);
  return (
    <main className={styles.login}>
      <section className={styles.loginAccessPanel}>
        <div className={styles.loginAccessInner}>
        <div className={styles.loginBrandRow}>
          <div className={styles.loginBrand}>
            <Image src="/brand/delta-logo.png" alt="Delta Carburant" width={184} height={184} priority />
          </div>
          <span className={styles.loginSecureBadge}><i/> Accès sécurisé</span>
        </div>
        <div className={styles.loginHeading}>
          <small>PLATEFORME DE PILOTAGE DU PARC</small>
          <h1>Bienvenue sur votre espace</h1>
          <p>Connectez-vous pour accéder au suivi consolidé des cartes, véhicules et consommations.</p>
        </div>
        <form onSubmit={onSubmit}>
          <label>
            <span>Adresse e-mail professionnelle</span>
            <div className={styles.loginInputWrap}><AppIcon name="users" size={18}/><input
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nom@entreprise.com"
              autoComplete="username"
              required
            /></div>
          </label>
          <label>
            <span>Mot de passe</span>
            <div className={styles.loginInputWrap}><AppIcon name="safe" size={18}/><input
              name="password"
              type={showPassword?"text":"password"}
              autoComplete="current-password"
              placeholder="Votre mot de passe"
              required
            /><button type="button" className={styles.passwordToggle} onClick={()=>setShowPassword(value=>!value)} aria-label={showPassword?"Masquer le mot de passe":"Afficher le mot de passe"}>{showPassword?"Masquer":"Afficher"}</button></div>
          </label>
          {error && <div className={styles.loginError}>{error}</div>}
          <button disabled={loading}>
            <span>{loading ? "Connexion sécurisée…" : "Accéder à la plateforme"}</span><AppIcon name="transfer" size={18}/>
          </button>
        </form>
        <div className={styles.loginTrust}><span><AppIcon name="check" size={14}/> Connexion chiffrée</span><span><AppIcon name="check" size={14}/> Accès par rôle</span><span><AppIcon name="check" size={14}/> Données centralisées</span></div>
        <small className={styles.loginFoot}>DeltaCarburant · Environnement professionnel sécurisé</small>
        </div>
      </section>
      <aside className={styles.loginShowcase}>
        <div className={styles.loginShowcaseGlow}/>
        <div className={styles.loginShowcaseTop}><span><i/> DONNÉES OPÉRATIONNELLES SYNCHRONISÉES</span><b>DeltaCarburant 2026</b></div>
        <div className={styles.loginShowcaseContent}>
          <div className={styles.loginLogoMark}><Image src="/brand/delta-logo.png" alt="Delta Carburant" width={230} height={230} priority /></div>
          <span className={styles.loginEyebrow}>COCKPIT DE GESTION CARBURANT</span>
          <h2>Une vision complète.<br/><em>Des décisions plus rapides.</em></h2>
          <p>Pilotez les cartes, les plafonds, les véhicules, les transactions et les anomalies depuis une interface unique.</p>
          <div className={styles.loginFeatureGrid} role="tablist" aria-label="Fonctionnalités de la plateforme">
            {loginFeatures.map((feature,index)=><button key={feature.title} type="button" role="tab" aria-selected={activeFeature===index} className={activeFeature===index?styles.loginFeatureActive:""} onClick={()=>setActiveFeature(index)}><span><AppIcon name={feature.icon} size={19}/></span><div><b>{feature.title}</b><small>{feature.caption}</small></div><i/></button>)}
          </div>
          <div className={styles.loginProductPreview} aria-live="polite">
            <div className={styles.loginPreviewHead}><span><AppIcon name={loginFeatures[activeFeature].icon} size={17}/>{loginFeatures[activeFeature].tag}</span><small>MODULE {String(activeFeature+1).padStart(2,"0")} / 04</small></div>
            <p>{loginFeatures[activeFeature].description}</p>
            <div className={styles.loginPreviewTrack}><i style={{width:`${(activeFeature+1)*25}%`}}/></div>
          </div>
        </div>
        <div className={styles.loginShowcaseFoot}><span>Direction Générale</span><span>Zin Finance</span><span>Gestionnaire Parc</span></div>
      </aside>
    </main>
  );
}
type TotalMobilityStatus={customerNumber?:string;siteNumber?:string;enabled?:boolean;syncIntervalMinutes?:number;lastSuccessAt?:string;lastError?:string};
type TotalMobilityRun={id:string;startedAt:string;status:string;fetchedRows:number;importedRows:number;duplicateRows:number;reviewRows?:number;errorMessage?:string;metadata?:{dateFrom?:string;dateTo?:string}};
type TotalAgentStatus={state:"IDLE"|"STARTING"|"SIGNING_IN"|"CODE_REQUIRED"|"EXTRACTING"|"SUCCESS"|"FAILED";message:string;updatedAt:string;result?:{imported?:number}};
type TotalCardReconciliation={id:string;cardNumber:string;applicationStatus:string;totalStatus?:string;checkedAt?:string;responsibleName?:string;conformity:"COMPLIANT"|"MISMATCH"|"NOT_EXTRACTED";pendingAction?:string};
type TotalMobilityPayload={CustomerId?:string;CustomerNumber?:string;SiteNumber?:string;UserId?:string;usersname?:string};
function readTotalMobilityPayload(raw:string):TotalMobilityPayload{
  const text=raw.trim();
  if(!text)throw new Error("Collez la configuration copiée depuis Total Mobility");
  try{return JSON.parse(text) as TotalMobilityPayload;}catch{/* DevTools peut copier une représentation non JSON. */}
  const read=(key:string)=>{
    const match=text.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"'\\r\\n]+)["']`,`i`));
    return match?.[1]?.trim();
  };
  return {CustomerId:read("CustomerId"),CustomerNumber:read("CustomerNumber"),SiteNumber:read("SiteNumber"),UserId:read("UserId"),usersname:read("usersname")};
}
function Settings({ reset,token,user,notify,onSynced }: { reset:()=>void;token:string|null;user:User;notify:(message:string)=>void;onSynced:()=>void }) {
  const [total,setTotal]=useState<TotalMobilityStatus>({});
  const [runs,setRuns]=useState<TotalMobilityRun[]>([]);
  const [busy,setBusy]=useState(false);
  const [agent,setAgent]=useState<TotalAgentStatus|null>(null);
  const [verificationCode,setVerificationCode]=useState("");
  const [totalCards,setTotalCards]=useState<TotalCardReconciliation[]>([]);
  const direction=isDirection(user.role);
  async function reconnectWithAgent(){
    if(!token)return;
    setBusy(true);
    try{
      const response=await fetch(`${API}/total-mobility/agent/start`,{method:"POST",headers:{Authorization:`Bearer ${token}`}});
      const body=await response.json().catch(()=>({})) as TotalAgentStatus&{message?:string|string[]};
      if(!response.ok)throw new Error(Array.isArray(body.message)?body.message.join(" · "):body.message||"Impossible de démarrer l’agent Total");
      setAgent(body);notify("L’agent se connecte à Total Mobility en arrière-plan.");
    }catch(error){notify(error instanceof Error?error.message:"Connexion automatique impossible");setBusy(false);}
  }
  async function submitVerificationCode(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!token)return;setBusy(true);try{const response=await fetch(`${API}/total-mobility/agent/code`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({code:verificationCode})});const body=await response.json().catch(()=>({})) as TotalAgentStatus&{message?:string|string[]};if(!response.ok)throw new Error(Array.isArray(body.message)?body.message.join(" · "):body.message||"Code refusé");setAgent(body);setVerificationCode("");}catch(error){notify(error instanceof Error?error.message:"Code Total refusé");}finally{setBusy(false);}}
  useEffect(()=>{if(!token||!agent||!["STARTING","SIGNING_IN","CODE_REQUIRED","EXTRACTING"].includes(agent.state))return;const poll=window.setInterval(()=>{void fetch(`${API}/total-mobility/agent/status`,{headers:{Authorization:`Bearer ${token}`}}).then(async response=>{if(!response.ok)return;const next=await response.json() as TotalAgentStatus;setAgent(next);if(next.state==="SUCCESS"){setBusy(false);notify(`Total connecté : ${next.result?.imported??0} transaction(s) actualisée(s).`);await loadTotal();onSynced();}else if(next.state==="FAILED"){setBusy(false);notify(next.message);}}).catch(()=>undefined);},1200);return()=>window.clearInterval(poll);},[agent,token]); // eslint-disable-line react-hooks/exhaustive-deps
  async function loadTotal(){if(!token||!direction)return;try{const headers={Authorization:`Bearer ${token}`};const [a,b,c]=await Promise.all([fetch(`${API}/total-mobility/status`,{headers}),fetch(`${API}/total-mobility/runs`,{headers}),fetch(`${API}/total-mobility/cards/reconciliation`,{headers})]);if(a.ok)setTotal(await a.json());if(b.ok)setRuns(await b.json());if(c.ok)setTotalCards(await c.json());}catch{/* Rechargement au prochain affichage. */}}
  useEffect(()=>{
    if(!token||!direction)return;
    const headers={Authorization:`Bearer ${token}`};
    void Promise.all([fetch(`${API}/total-mobility/status`,{headers}),fetch(`${API}/total-mobility/runs`,{headers}),fetch(`${API}/total-mobility/cards/reconciliation`,{headers})])
      .then(async([statusResponse,runsResponse,cardsResponse])=>{
        if(statusResponse.ok)setTotal(await statusResponse.json());
        if(runsResponse.ok)setRuns(await runsResponse.json());
        if(cardsResponse.ok)setTotalCards(await cardsResponse.json());
      }).catch(()=>undefined);
  },[token,direction]);
  async function connect(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!token)return;const formElement=event.currentTarget;setBusy(true);try{const form=new FormData(formElement);const simplePayload=String(form.get("totalPayload")??"").trim();const copied=simplePayload?readTotalMobilityPayload(simplePayload):{};const configuration={customerId:copied.CustomerId||String(form.get("customerId")??""),customerNumber:copied.CustomerNumber||String(form.get("customerNumber")??""),siteNumber:copied.SiteNumber||String(form.get("siteNumber")??""),userId:copied.UserId||String(form.get("totalUserId")??""),username:copied.usersname||String(form.get("totalUsername")??""),refreshToken:String(form.get("refreshToken")??""),syncIntervalMinutes:Number(form.get("syncIntervalMinutes")??60)};if(!configuration.customerId||!configuration.customerNumber||!configuration.siteNumber)throw new Error("La configuration copiée ne contient pas les informations client Total. Utilisez « Copy value » sur Request Payload.");const response=await fetch(`${API}/total-mobility/connect`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(configuration)});if(!response.ok){const raw=await response.text();let message="";try{const body=JSON.parse(raw) as {message?:string|string[]};message=Array.isArray(body.message)?body.message.join(" · "):body.message??"";}catch{message=raw;}throw new Error(message||`Connexion Total refusée (${response.status})`);}formElement.reset();notify("Total Mobility est connecté. Les transactions seront désormais extraites automatiquement, sans fichier CSV ou Excel.");await loadTotal();}catch(error){notify(error instanceof Error?error.message:"Connexion Total impossible");}finally{setBusy(false);}}
  async function sync(){if(!token)return;setBusy(true);try{const response=await fetch(`${API}/total-mobility/sync`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({fromDate:"2026-08-01"})});if(!response.ok)throw new Error(await response.text());const result=await response.json();notify(`Mise à jour temps réel terminée : ${result.imported??0} transaction(s) réécrite(s) · ${result.replaced??0} ancienne(s) remplacée(s) · ${result.pendingReview??0} à contrôler`);await loadTotal();onSynced();}catch(error){notify(error instanceof Error?error.message:"Synchronisation Total impossible");}finally{setBusy(false);}}
  return (
    <section className={styles.settings}>
      {direction&&<article className={styles.totalConnector}>
        <div className={styles.connectorHead}><div><small>EXTRACTION DIRECTE — SANS CSV / EXCEL</small><h2>TotalEnergies Mobility</h2><p>Chaque extraction remplace l’ancien état depuis le 01/08/2026 par le nouvel instantané officiel Total.</p></div><span className={total.customerNumber&&total.enabled?styles.connectorOnline:styles.connectorOffline}>{total.customerNumber&&total.enabled?"● Connecté":"○ Non connecté"}</span></div>
        {total.customerNumber&&<><div className={styles.connectorMetrics}><span><small>Client</small><b>{total.customerNumber}</b></span><span><small>Site</small><b>{total.siteNumber}</b></span><span><small>Fréquence</small><b>{total.syncIntervalMinutes} min</b></span><span><small>Dernier succès</small><b>{total.lastSuccessAt?new Date(total.lastSuccessAt).toLocaleString("fr-FR"):"Jamais"}</b></span></div>{total.lastError&&<div className={styles.connectorError}>⚠ {total.lastError}</div>}<button disabled={busy} onClick={sync}>{busy?"Extraction depuis Total…":"Extraire depuis Total (depuis le 01/08/2026)"}</button></>}
        <button className={styles.connectorConnectButton} disabled={busy} onClick={reconnectWithAgent}>{busy?"Agent Total en cours…":"Se connecter et extraire automatiquement"}</button>
        <p><small>L’agent serveur utilise les secrets Render, renouvelle la session puis extrait les transactions. Aucun portail, extension ou paramétrage manuel.</small></p>
        <details className={styles.connectorConfig}><summary>Mode de secours administrateur</summary><form onSubmit={connect} className={styles.connectorForm}>
          <div className={styles.connectorGuide}><b>1</b><span><strong>Copiez la configuration des transactions</strong><small>Total Mobility → F12 → Network → requête <code>report/list</code> → Payload → clic droit → Copy value.</small></span></div>
          <label className={styles.connectorSecret}>Configuration Total copiée<textarea name="totalPayload" rows={5} placeholder={'Collez ici tout le Request Payload. Les champs client, site et utilisateur seront détectés automatiquement.'} /></label>
          <div className={styles.connectorGuide}><b>2</b><span><strong>Collez le jeton de connexion</strong><small>F12 → Application → Local Storage → <code>refresh_token</code>. Ne le partagez avec personne.</small></span></div>
          <label className={styles.connectorSecret}>Jeton sécurisé Total<input name="refreshToken" type="password" autoComplete="new-password" required minLength={20} /><small>Il est testé, chiffré puis jamais réaffiché dans le navigateur.</small></label>
          <label>Synchronisation automatique<select name="syncIntervalMinutes" defaultValue={total.syncIntervalMinutes??60}><option value="15">Toutes les 15 minutes</option><option value="30">Toutes les 30 minutes</option><option value="60">Toutes les heures</option><option value="120">Toutes les 2 heures</option></select></label>
          <details className={styles.connectorAdvanced}><summary>Mode avancé — saisie manuelle</summary><div><label>Customer ID<input name="customerId" autoComplete="off" /></label><label>Numéro client<input name="customerNumber" defaultValue={total.customerNumber??""} /></label><label>Numéro du site<input name="siteNumber" defaultValue={total.siteNumber??"9051"} /></label><label>User ID<input name="totalUserId" autoComplete="off" /></label><label>Nom technique<input name="totalUsername" autoComplete="off" /></label></div></details>
          <button className={styles.connectorConnectButton} disabled={busy}>{busy?"Détection et vérification…":"Détecter et connecter automatiquement"}</button>
        </form></details>
        {runs.length>0&&<details className={styles.connectorRuns} open><summary>Journal des extractions Total</summary><div className={styles.tableWrap}><table><thead><tr><th>Date</th><th>Période</th><th>État</th><th>Reçues</th><th>Réécrites</th><th>Doublons</th><th>À contrôler</th></tr></thead><tbody>{runs.slice(0,10).map(run=><tr key={run.id}><td>{new Date(run.startedAt).toLocaleString("fr-FR")}</td><td>{run.metadata?.dateFrom==="2026-08-01"?"Depuis le 01/08/2026":run.metadata?.dateFrom??"Automatique"}</td><td><b>{run.status}</b>{run.errorMessage&&<small> — {run.errorMessage}</small>}</td><td>{run.fetchedRows}</td><td>{run.importedRows}</td><td>{run.duplicateRows}</td><td>{run.reviewRows??0}</td></tr>)}</tbody></table></div></details>}
        {totalCards.length>0&&<details className={styles.connectorRuns} open><summary>Conformité des statuts des cartes ({totalCards.filter(card=>card.conformity==='MISMATCH').length} écart(s))</summary><div className={styles.tableWrap}><table><thead><tr><th>Carte</th><th>Responsable</th><th>Application</th><th>Total réel</th><th>Conformité</th><th>Action Total à faire</th></tr></thead><tbody>{totalCards.map(card=><tr key={card.id}><td><b>{card.cardNumber}</b></td><td>{card.responsibleName??'Coffre'}</td><td>{card.applicationStatus}</td><td>{card.totalStatus??'Non extrait'}</td><td><b>{card.conformity==='COMPLIANT'?'✓ Conforme':card.conformity==='MISMATCH'?'⚠ Écart':'○ À extraire'}</b></td><td>{card.pendingAction==='DEACTIVATE'?'Désactiver dans Gérer les cartes':card.pendingAction==='ACTIVATE'?'Activer dans Gérer les cartes':'—'}</td></tr>)}</tbody></table></div></details>}
      </article>}
      {agent&&["STARTING","SIGNING_IN","CODE_REQUIRED","EXTRACTING","FAILED","SUCCESS"].includes(agent.state)&&<div className={styles.overlay}><section className={`${styles.modal} ${styles.totalAgentModal}`}><div className={styles.modalHead}><div><h2>Agent Total Mobility</h2><p>Connexion et extraction sécurisées</p></div>{["FAILED","SUCCESS"].includes(agent.state)&&<button type="button" onClick={()=>setAgent(null)}>×</button>}</div><div className={styles.agentBody}><span className={`${styles.agentPulse} ${agent.state==="FAILED"?styles.agentFailed:""}`}>{agent.state==="SUCCESS"?"✓":agent.state==="FAILED"?"!":"●"}</span><h3>{agent.message}</h3>{agent.state==="CODE_REQUIRED"&&<form onSubmit={submitVerificationCode}><label>Code de vérification reçu<input autoFocus inputMode="numeric" autoComplete="one-time-code" value={verificationCode} onChange={event=>setVerificationCode(event.target.value.replace(/\D/g,"").slice(0,8))} placeholder="000000" minLength={4} required /></label><button disabled={busy||verificationCode.length<4}>Valider le code</button></form>}{!["CODE_REQUIRED","FAILED","SUCCESS"].includes(agent.state)&&<p>Gardez cette fenêtre ouverte. L’opération continue automatiquement.</p>}{agent.state==="FAILED"&&<p>Vérifiez les secrets Render ou réessayez. Si Total affiche un CAPTCHA, celui-ci doit être traité manuellement.</p>}{agent.state==="SUCCESS"&&<button onClick={()=>setAgent(null)}>Terminer</button>}</div></section></div>}
      <article>
        <h2>Règles des rôles</h2>
        <p>
          Responsables hors parc : affectations, demandes, répartitions et kilométrage hebdomadaire.
          <br />
          Zin, DG et Superadmin : gestion complète, imports, modifications et
          suppressions.
        </p>
      </article>
      <article>
        <h2>Cache local de l’interface</h2>
        <p>Les données métier de référence sont enregistrées dans PostgreSQL.</p>
        <button className={styles.danger} onClick={reset}>
          Réinitialiser les données
        </button>
      </article>
    </section>
  );
}
const titles: Record<string, string> = {
  card: "Créer une carte",
  beneficiary: "Nouveau bénéficiaire",
  vehicle: "Nouveau véhicule",
  driver: "Nouveau chauffeur",
  fuelPrice: "Mise à jour du prix carburant",
  editRow: "Modifier l’enregistrement",
  editTransaction: "Corriger une transaction",
  request: "Nouvelle demande",
  mileage:"Relevé kilométrique hebdomadaire",
  settings: "Configuration",
  import: "Importer les transactions Total",
};
function MonthlyConsumptionGauge({consumed,creditLine}:{consumed:number;creditLine:number}){
  const rawRate=creditLine>0?consumed/creditLine*100:0;
  const rate=Math.max(0,Math.min(100,rawRate));
  const formattedRate=rawRate.toLocaleString("fr-FR",{minimumFractionDigits:2,maximumFractionDigits:2});
  return <section className={styles.monthlyGauge} aria-label={`Consommation mensuelle ${formattedRate} pour cent`}>
    <div className={styles.gaugeHeading}>
      <div><small>INDICATEUR DIRECTION GÉNÉRALE</small><h2>Jauge de consommation</h2><p><b>Période :</b> Mensuelle · Source officielle TotalEnergies</p></div>
      <span>Actualisation automatique</span>
    </div>
    <div className={styles.gaugeVisual}>
      <svg viewBox="0 0 240 132" role="img" aria-hidden="true">
        <defs><linearGradient id="gaugeGradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#11b6a3"/><stop offset=".58" stopColor="#286bd3"/><stop offset="1" stopColor="#7439b2"/></linearGradient></defs>
        <path className={styles.gaugeTrack} pathLength="100" d="M 24 116 A 96 96 0 0 1 216 116" />
        <path className={styles.gaugeValue} pathLength="100" strokeDasharray={`${rate} 100`} d="M 24 116 A 96 96 0 0 1 216 116" />
      </svg>
      <div className={styles.gaugeRate}><strong>{formattedRate}%</strong><small>du plafond consommé</small></div>
    </div>
    <div className={styles.gaugeFigures}>
      <div><small>Consommation Total</small><strong>{consumed.toLocaleString("fr-FR",{maximumFractionDigits:3})} TND</strong></div>
      <i aria-hidden="true" />
      <div><small>Ligne de crédit distribuée</small><strong>{creditLine.toLocaleString("fr-FR",{maximumFractionDigits:3})} TND</strong></div>
      <i aria-hidden="true" />
      <div><small>Crédit disponible</small><strong>{Math.max(0,creditLine-consumed).toLocaleString("fr-FR",{maximumFractionDigits:3})} TND</strong></div>
    </div>
  </section>;
}
function Metric({
  icon,
  color,
  label,
  value,
  note,
}: {
  icon: IconName;
  color: string;
  label: string;
  value: string | number;
  note: string;
}) {
  return (
    <article className={`${styles.metric} ${styles[`metric_${color}`] ?? ""}`}>
      <div className={`${styles.metricIcon} ${styles[color]}`}><AppIcon name={icon} size={23}/></div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{note}</small>
      </div>
    </article>
  );
}
function Action({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: IconName;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick}>
      <i><AppIcon name={icon} size={20}/></i>
      <span>
        <b>{title}</b>
        <small>{sub}</small>
      </span>
    </button>
  );
}
function roleLabel(r: Role) {
  return {
    SUPER_ADMIN: "Superadmin",
    DIRECTION_GENERAL: "Direction Générale",
    ZIN_FINANCE: "Zin Finance",
    NAJIB_ASSIGNER: "Responsable hors parc",
  }[r];
}
function permissionText(r: Role) {
  return r === "SUPER_ADMIN"
    ? "Administration complète"
    : r === "DIRECTION_GENERAL"
      ? "Supervision et gestion complète"
      : r === "ZIN_FINANCE"
        ? "Traiter, valider et bloquer"
        : "Affecter et créer des demandes";
}
function status(s: CardStatus) {
  return {
    TO_ASSIGN: "À affecter",
    ASSIGNED: "Affectée",
    DISTRIBUTED: "Distribuée",
    ACTIVE: "Active",
    SAFE: "En coffre — non distribuée",
    SUSPENDED: "Suspendue",
    LOST: "Perdue",
    STOLEN: "Volée",
    OPPOSED: "Opposée",
    REPLACED: "Remplacée",
  }[s];
}
function financeStatus(s: FinanceStatus) {
  return {
    PENDING: "À vérifier",
    CONFIRMED: "Confirmé Zin",
    REJECTED: "Refusé Zin",
  }[s];
}
function normalizedKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
function totalValue(source: Record<string, unknown>, aliases: string[]) {
  const wanted = aliases.map(normalizedKey);
  const keys = Object.keys(source);
  // Prefer an exact header. TotalEnergies exports contain several columns named
  // with the same stem (Montant preautorise, Montant, Montant bonus, etc.).
  const key = keys.find((k) => wanted.includes(normalizedKey(k))) ?? keys.find((k) =>
    wanted.some((alias) => alias.length >= 6 && normalizedKey(k).includes(alias)),
  );
  return key ? source[key] : "";
}
function totalPaymentNumberKey(source: Record<string, unknown>) {
  const exactAliases = new Set([
    "numerodumodedepaiement",
    "numeromodedepaiement",
    "numerodemodedepaiement",
    "numerodumoyendepaiement",
    "numeromoyendepaiement",
    "numerodemoyendepaiement",
    "nmodedepaiement",
    "nomodedepaiement",
    "nmoyendepaiement",
    "nomoyendepaiement",
    "numerodusupportdepaiement",
    "numerosupportdepaiement",
    "nsupportdepaiement",
    "numpaiement",
    "paymentmethodnumber",
  ]);
  const keys = Object.keys(source);
  // TotalEnergies utilise selon l'export « Numéro du mode de paiement »,
  // « N° mode de paiement » ou « N° du mode de paiement ».
  return keys.find((header) => exactAliases.has(normalizedKey(header))) ??
    keys.find((header) => {
      const key = normalizedKey(header);
      return key.endsWith("modedepaiement") ||
        key.endsWith("moyendepaiement") ||
        key.endsWith("supportdepaiement");
    });
}
function totalHolderName(source: Record<string, unknown>) {
  const exactAliases = new Set([
    "nomdutitulairedumodedepaiement",
    "nomdutitulairedumoyendepaiement",
    "nomdutitulaire",
    "titulaire",
    "cardholdername",
  ]);
  const key = Object.keys(source).find((header) =>
    exactAliases.has(normalizedKey(header)),
  );
  const holder = key ? String(source[key] ?? "").trim() : "";
  if (holder) return holder;
  // Le chauffeur n'est qu'un secours : dans les exports Total il est souvent
  // vide, tandis que le titulaire identifie toujours la carte de référence.
  return String(
    totalValue(source, ["nomdechauffeur", "nomduchauffeur", "conducteur"]) ?? "",
  ).trim();
}
function displayDate(value: unknown) {
  if (value instanceof Date) return value.toLocaleString("fr-MA");
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed)
      return new Date(
        parsed.y,
        parsed.m - 1,
        parsed.d,
        parsed.H,
        parsed.M,
        parsed.S,
      ).toLocaleString("fr-MA");
  }
  return String(value || "—");
}
function totalTransaction(
  source: Record<string, unknown>,
  filename: string,
  index: number,
): Row {
  const paymentKey = totalPaymentNumberKey(source);
  const rawCard = String(paymentKey ? source[paymentKey] : "").trim();
  const digits = rawCard.replace(/\D/g, "");
  const quantity = totalValue(source, [
    "quantite",
    "volume",
    "litres",
    "quantity",
  ]);
  // La consommation d'une ligne est exclusivement la valeur de la colonne
  // "Montant" du fichier Total. Les autres colonnes (montant préautorisé,
  // bonus, plafond, etc.) ne sont pas des consommations.
  const amountKey = Object.keys(source).find(
    (header) => normalizedKey(header) === "montant",
  );
  const amount = amountKey ? source[amountKey] : "";
  const rawDate=totalValue(source, ["datetransaction", "dateoperation", "date"]);
  const rawTime=totalValue(source,["heuredelatransaction","heuretransaction","heure"]);
  const excelDate=typeof rawDate==="number"?XLSX.SSF.parse_date_code(rawDate):null;
  const frenchDate=String(rawDate??"").trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const parsedDate=rawDate instanceof Date
    ? new Date(rawDate)
    : excelDate
      ? new Date(excelDate.y,excelDate.m-1,excelDate.d,excelDate.H,excelDate.M,Math.floor(excelDate.S))
      : frenchDate
        ? new Date(Number(frenchDate[3]),Number(frenchDate[2])-1,Number(frenchDate[1]),Number(frenchDate[4]??0),Number(frenchDate[5]??0),Number(frenchDate[6]??0))
        : new Date(String(rawDate));
  const excelTime=typeof rawTime==="number"?XLSX.SSF.parse_date_code(rawTime):null;
  const timeMatch=String(rawTime??"").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const timeParts=rawTime instanceof Date
    ? [rawTime.getHours(),rawTime.getMinutes(),rawTime.getSeconds()]
    : excelTime
      ? [excelTime.H,excelTime.M,Math.floor(excelTime.S)]
      : timeMatch
        ? [Number(timeMatch[1]),Number(timeMatch[2]),Number(timeMatch[3]??0)]
        : null;
  if(!Number.isNaN(parsedDate.getTime())&&timeParts) parsedDate.setHours(timeParts[0],timeParts[1],timeParts[2],0);
  return {
    id: `total-${filename}-${index}-${crypto.randomUUID()}`,
    date: displayDate(rawDate),
    // Une date invalide ne doit jamais être remplacée par « maintenant » :
    // deux imports identiques deviendraient artificiellement deux mouvements.
    dateApi: Number.isNaN(parsedDate.getTime()) ? "" : parsedDate.toISOString(),
    carte: digits || rawCard,
    station: String(
      totalValue(source, [
        "nomdelastation",
        "nomstation",
        "stationservice",
        "station",
        "site",
        "pointdevente",
      ]) || "—",
    ),
    vehicule: String(totalValue(source,["plaquedimmatriculation","immatriculation","matriculevehicule","vehicle","registration"])||""),
    beneficiaire: totalHolderName(source),
    produit: String(totalValue(source,["nomdeproduit","nomduproduit","produit","product","carburant"])||"—"),
    kilometragePrecedent: parseNumeric(totalValue(source,["kilometrageprecedent"])),
    kilometrage: parseNumeric(totalValue(source,["kilometrageactuelle","kilometrageactuel"])),
    codeAutorisation: String(totalValue(source,["codedautorisation","codeautorisation","numerodetransaction"])||""),
    litres: `${String(quantity || "0")} L`,
    montant: `${String(amount || "0")} MAD`,
    statut: "Importée Total",
    fichier: filename,
    source: "TOTAL_EXCEL",
  };
}
function parseNumeric(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let raw = String(value ?? "").trim().replace(/[^0-9,.-]/g, "");
  if (!raw) return 0;
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    raw = raw.split(thousandsSeparator).join("");
    if (decimalSeparator === ",") raw = raw.replace(",", ".");
  } else if (comma >= 0) {
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else {
    const dotCount = (raw.match(/\./g) ?? []).length;
    if (dotCount > 1) {
      const parts = raw.split(".");
      raw = `${parts.slice(0, -1).join("")}.${parts.at(-1)}`;
    }
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
function download(rows: Row[], name: string) {
  const blob = new Blob([JSON.stringify(rows, null, 2)], {
      type: "application/json",
    }),
    a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `delta-${name}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

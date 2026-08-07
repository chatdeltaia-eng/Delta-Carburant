"use client";

import { FormEvent, Fragment, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import styles from "./page.module.css";

type Role =
  "SUPER_ADMIN" | "DIRECTION_GENERAL" | "ZIN_FINANCE" | "NAJIB_ASSIGNER";
type User = { name: string; role: Role; email: string };
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
  | "settings";
type CardStatus =
  | "TO_ASSIGN"
  | "ASSIGNED"
  | "DISTRIBUTED"
  | "ACTIVE"
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
  consumption_rate?:number;
  responsible_user_id?:string;
  company_id?:string;
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

// Browser requests stay on the same origin. Next.js proxies this path to the
// API service, so the API hostname does not need to be exposed to clients.
const API = "/api/v1";
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
  const authorRole = status === "CANCELLED" ? row.requestedByRole : row.decisionByRole ?? row.requestedByRole;
  const label = status === "APPROVED" ? "Demande validée" : status === "REJECTED" ? "Demande refusée" : status === "CANCELLED" ? "Demande annulée" : "Demande créée";
  const dateValue = status === "SUBMITTED" ? row.createdAt : row.decisionDate ?? row.createdAt;
  return `${label} par ${roleName[String(authorRole)] ?? "Utilisateur"} · ${new Date(String(dateValue)).toLocaleString("fr-MA")}`;
};
const toRequestRow = (row: Record<string, unknown>): Row => ({
  id: String(row.id),
  numero: String(row.requestNumber ?? "—"),
  type: String(row.requestType) === "LIMIT_CHANGE" ? "Augmentation de plafond" : String(row.requestType)==="CARD_FUNDING"?"Alimentation de carte":"Nouvelle carte",
  beneficiaire: String(row.beneficiary ?? "—"),
  departement: String(row.department ?? "—"),
  voiture: String(row.vehicle ?? "—"),
  plafond: Number(row.requestedLimit ?? 0),
  plafondActuel: Number(row.currentLimit ?? 0),
  carte: String(row.cardNumber ?? "—"),
  carteSource:String(row.sourceCardNumber??"—"),
  statut: requestStatus[String(row.status)] ?? String(row.status ?? "—"),
  motif: String(row.decisionReason ?? row.reason ?? "—"),
  suivi: requestTracking(row),
  recu: String(row.receiptNumber ?? "—"),
});
const initialCards: Card[] = [];
const seeds: Record<string, Row[]> = {
  beneficiaries: [],
  vehicles: `
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
    }),
  transactions: [],
  requests: [],
  mileage: [],
  anomalies: [],
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
    "Données importées de TotalEnergies ; correction Zin/DG avec historique.",
  ],
  requests: ["Demandes", "Suivez les workflows et validations."],
  mileage: ["Kilométrage hebdomadaire", "Suivez les relevés, distances détectées et validations."],
  anomalies: ["Anomalies", "Analysez les alertes détectées."],
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
    [data, setData] = useState(seeds),
    [databaseSummary, setDatabaseSummary] = useState<Record<string, number> | null>(null),
    [responsibles,setResponsibles]=useState<{id:string;name:string;email:string}[]>([]),
    [companies,setCompanies]=useState<{id:string;code:string;name:string}[]>([]),
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
    [loading, setLoading] = useState(false);
  // Hydrate the browser-only demo session after the client mounts.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const t = sessionStorage.getItem("delta_access"),
      u = sessionStorage.getItem("delta_user"),
      saved = localStorage.getItem("delta_app_data_v1");
    // Retire définitivement les anciennes données fictives des versions démo.
    localStorage.removeItem("delta_demo_data_v6");
    if (t && t !== "demo" && u) {
      setToken(t);
      setUser(JSON.parse(u));
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
        vehicles: Array.isArray(savedData.vehicles) ? savedData.vehicles : seeds.vehicles,
      });
      setNotifications(x.notifications ?? []);
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!token || !user) return;
    const headers = { Authorization: `Bearer ${token}` };
    const refreshRemote = () => Promise.all([
      fetch(`${API}/cards`, { headers, cache: "no-store" }),
      fetch(`${API}/requests`, { headers, cache: "no-store" }),
      fetch(`${API}/notifications`, { headers, cache: "no-store" }),
      fetch(`${API}/transactions`, { headers, cache: "no-store" }),
      fetch(`${API}/dashboard/summary`, { headers, cache: "no-store" }),
      canManage(user.role) ? fetch(`${API}/transactions/reviews`, { headers, cache: "no-store" }) : Promise.resolve(null),
      fetch(`${API}/vehicles`, { headers, cache: "no-store" }),
      fetch(`${API}/mileage`, { headers, cache: "no-store" }),
      fetch(`${API}/drivers`, { headers, cache: "no-store" }),
      fetch(`${API}/fuel-prices`, { headers, cache: "no-store" }),
      canManage(user.role)?fetch(`${API}/cards/responsibles`,{headers,cache:"no-store"}):Promise.resolve(null),
      canManage(user.role)?fetch(`${API}/cards/companies`,{headers,cache:"no-store"}):Promise.resolve(null),
    ])
      .then(async ([cardResponse, requestResponse, notificationResponse,transactionResponse,summaryResponse,reviewsResponse,vehiclesResponse,mileageResponse,driversResponse,fuelPricesResponse,responsiblesResponse,companiesResponse]) => {
        // Management reference data must remain usable even if an unrelated
        // dashboard endpoint is temporarily unavailable.
        if(responsiblesResponse?.ok)setResponsibles(await responsiblesResponse.json());
        if(companiesResponse?.ok)setCompanies(await companiesResponse.json());
        if (!cardResponse.ok || !requestResponse.ok || !notificationResponse.ok || !transactionResponse.ok || !summaryResponse.ok || !vehiclesResponse.ok || !mileageResponse.ok || !driversResponse.ok || !fuelPricesResponse.ok)
          throw new Error("Impossible de charger les données distantes");
        const cardPayload = await cardResponse.json();
        const requestPayload = await requestResponse.json();
        const notificationPayload = await notificationResponse.json();
        const transactionPayload = await transactionResponse.json();
        const summaryPayload = await summaryResponse.json();
        const reviewsPayload = reviewsResponse?.ok ? await reviewsResponse.json() : [];
        const vehiclesPayload=await vehiclesResponse.json();
        const mileagePayload=await mileageResponse.json();
        const driversPayload=await driversResponse.json(); const fuelPricesPayload=await fuelPricesResponse.json();
        setCards(cardPayload.items ?? cardPayload);
        setNotifications((notificationPayload.items ?? notificationPayload).map(
          (row: Record<string, unknown>) => toNotification(row, user.role),
        ));
        setData((current) => ({
          ...current,
          requests: (requestPayload.items ?? requestPayload).map(toRequestRow),
          transactions: (transactionPayload.items ?? transactionPayload).map((row:Record<string,unknown>) => ({ id:String(row.id),reviewId:String(row.reviewId??""),date:new Date(String(row.date)).toLocaleString("fr-MA"),carte:String(row.card),beneficiaire:String(row.beneficiary??"—"),vehicule:String(row.vehicle??"—"),station:String(row.station??"—"),produit:String(row.product??"—"),litres:Number(row.liters),montant:Number(row.amount),montantReparti:Number(row.allocatedAmount??0),repartitionEnAttente:String(row.pendingAllocationId??""),statut:row.reviewStatus==="PENDING"?(row.reviewIssue==="MISSING_BENEFICIARY"?"Bénéficiaire à identifier":"Véhicule inconnu à valider"):"Importée Total",fichier:String(row.file??"—") })),
          anomalies: (reviewsPayload.items ?? reviewsPayload).map((row:Record<string,unknown>) => ({ id:String(row.id),date:new Date(String(row.date)).toLocaleString("fr-MA"),type:String(row.issueType)==="MISSING_BENEFICIARY"?"Bénéficiaire manquant":"Véhicule inconnu",carte:String(row.cardNumber),vehicule:String(row.vehicle??"—"),station:String(row.station??"—"),produit:String(row.product??"—"),litres:Number(row.liters),montant:Number(row.amount),gravite:"Haute",statut:String(row.status)==="PENDING"?"À vérifier":String(row.status)==="ACCEPTED"?"Acceptée":"Refusée" })),
          vehicles:(vehiclesPayload.items??vehiclesPayload).map((row:Record<string,unknown>)=>({id:String(row.id),numero:Number(row.fleetNumber??0),immatriculation:String(row.registration),type:String(row.vehicleType??row.model??"—"),societe:String(row.company??"—"),mise_en_circulation:row.firstRegistrationDate?new Date(String(row.firstRegistrationDate)).toLocaleDateString("fr-FR"):"À compléter",reference:[row.brand,row.model].filter(Boolean).join(" "),conducteur:String(row.driver??"—"),kilometrage:Number(row.lastMileage??0),statut:Boolean(row.active)?"Actif":"Inactif"})),
          mileage:(mileagePayload.items??mileagePayload).map((row:Record<string,unknown>)=>({id:String(row.id),semaine:String(row.week??"—"),vehicule:String(row.vehicle),societe:String(row.company),responsable:String(row.responsible??"—"),precedent:Number(row.previousMileage??0),distanceDetectee:Number(row.detectedDistance??0),attendu:Number(row.expectedMileage??0),kilometrage:Number(row.mileage),anomalie:Boolean(row.anomaly)?"Oui":"Non",statut:String(row.status)==="PENDING"?"EN_ATTENTE_ZIN":String(row.status)==="VALIDATED"?"VALIDEE_ZIN":"REFUSEE_ZIN",validateur:String(row.reviewer??"—")})),
          drivers:(driversPayload.items??driversPayload).map((row:Record<string,unknown>)=>({id:String(row.id),societe:String(row.company),nom:String(row.fullName),cin:String(row.cin??"—"),telephone:String(row.phone??"—"),permis:String(row.licenseNumber??"—"),vehicules:Array.isArray(row.vehicles)?(row.vehicles as {registration:string}[]).map(item=>item.registration).join(", "):"—",statut:Boolean(row.active)?"Actif":"Inactif"})),
          fuelPrices:(fuelPricesPayload.items??fuelPricesPayload).map((row:Record<string,unknown>)=>({id:String(row.id),societe:String(row.company),produit:String(row.product),ancienPrix:Number(row.oldPrice),nouveauPrix:Number(row.newPrice),variation:`${Number(row.variationPercent).toFixed(2)} %`,date:new Date(String(row.effectiveDate)).toLocaleDateString("fr-FR"),auteur:String(row.createdBy??"—")})),
        }));
        setDatabaseSummary(summaryPayload);
      })
      .catch(() => setError("API distante indisponible — aucune donnée locale ne sera enregistrée"));
    refreshRemote();
    const timer = window.setInterval(refreshRemote, 10000);
    return () => window.clearInterval(timer);
  }, [token, user, refreshTick]);
  const persist = (
    nextCards = cards,
    nextData = data,
    nextNotifications = notifications,
  ) =>
    localStorage.setItem(
      "delta_app_data_v1",
      JSON.stringify({
        cards: nextCards,
        data: nextData,
        notifications: nextNotifications,
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
      setToken(x.accessToken);
      setUser(x.user);
    } catch {
      setError("Connexion à l’API impossible ou identifiants invalides");
    } finally {
      setLoading(false);
    }
  }
  async function logout() {
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
      let change: Partial<Card> = { updated_at: today };
      if (action === "assign") {
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
        if(!canManage(user.role)||!token)return notify("Attribution réservée à Zin et à la DG");
        const responsibleUserId=String(f.get("responsibleUserId")||"");if(!responsibleUserId)return notify("Sélectionnez un responsable");
        try{const response=await fetch(`${API}/cards/${selected.id}/responsible`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({responsibleUserId})});if(!response.ok)throw new Error(await response.text());change={...change,card_category:"OFF_PARK",responsible_user_id:responsibleUserId};}catch{return notify("L’attribution n’a pas été enregistrée");}
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
        if (!isDirection(user.role) && user.role !== "ZIN_FINANCE")
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
      const next = cards.map((c) =>
        c.id === selected.id ? { ...c, ...change } : c,
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
      if(user.role!=="NAJIB_ASSIGNER")return notify("Le relevé est saisi par un responsable hors parc");
      if(!token)return notify("Session distante expirée");
      try{const response=await fetch(`${API}/mileage`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({vehicleId:String(f.get("vehicleId")),mileage:Number(f.get("mileage")),note:String(f.get("note")??"")})});if(!response.ok)throw new Error(await response.text());const created=await response.json();notify(created.anomaly?`Anomalie détectée : kilométrage attendu ${created.expectedMileage}`:"Relevé envoyé à Zin et à la DG");}catch(error){return notify(error instanceof Error?error.message:"Échec du relevé kilométrique");}
    } else if(modal==="driver"||modal==="fuelPrice"){
      if(!canManage(user.role)||!token)return notify("Action réservée à Zin et à la DG");
      const endpoint=modal==="driver"?"drivers":"fuel-prices";
      const body=modal==="driver"?{companyId:String(f.get("companyId")),fullName:String(f.get("fullName")),cin:String(f.get("cin")||"")||undefined,phone:String(f.get("phone")||"")||undefined,licenseNumber:String(f.get("licenseNumber")||"")||undefined}:{companyId:String(f.get("companyId")),product:String(f.get("product")),newPrice:Number(f.get("newPrice")),effectiveDate:String(f.get("effectiveDate")||"")||undefined};
      try{const response=await fetch(`${API}/${endpoint}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(body)});if(!response.ok)throw new Error(await response.text());notify(modal==="driver"?"Chauffeur ajouté":"Prix enregistré et plafonds ajustés");}catch(error){return notify(error instanceof Error?error.message:"Enregistrement impossible");}
    } else if (modal && ["beneficiary", "vehicle", "request"].includes(modal)) {
      if (modal === "request" && user.role !== "NAJIB_ASSIGNER")
        return notify(
          "Les demandes de carte passent obligatoirement par Najib",
        );
      if (modal !== "request" && !canManage(user.role))
        return notify("Action réservée à Zin et à la Direction Générale");
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
        row.type = String(row.typeDemande) === "LIMIT_CHANGE" ? "Augmentation de plafond" : String(row.typeDemande)==="CARD_FUNDING"?"Alimentation de carte":"Nouvelle carte";
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
              fuelCardId: row.carteId ? String(row.carteId) : undefined,
              sourceCardId: row.carteSourceId ? String(row.carteSourceId) : undefined,
              beneficiary: String(row.beneficiaire),
              department: String(row.departement),
              vehicle: String(row.voiture),
              requestedLimit: parseNumeric(row.plafond),
              reason: String(row.motif),
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
          title: String(row.typeDemande) === "LIMIT_CHANGE" ? "Demande d’augmentation de plafond" : String(row.typeDemande)==="CARD_FUNDING"?"Demande d’alimentation de carte":"Nouvelle demande de carte",
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
        const normalized = sourceRows.map((source, index) =>
          totalTransaction(source, file.name, index),
        );
        if (!token) return notify("Session distante expirée : reconnectez-vous");
        const response=await fetch(`${API}/transactions/import`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({filename:file.name,rows:normalized.map(row=>({date:String(row.dateApi),cardNumber:String(row.carte),vehicle:String(row.vehicule??""),beneficiary:String(row.beneficiaire??""),station:String(row.station??""),product:String(row.produit??""),liters:parseNumeric(row.litres),amount:parseNumeric(row.montant),previousMileage:parseNumeric(row.kilometragePrecedent)||undefined,mileage:parseNumeric(row.kilometrage)||undefined,authorizationCode:String(row.codeAutorisation??"")||undefined}))})});
        if(!response.ok) throw new Error(await response.text());
        const result=await response.json();
        setRefreshTick(value=>value+1);
        setView("dashboard");
        notify(`${result.imported} transaction(s) liée(s) automatiquement · ${result.duplicates} doublon(s) · ${result.pendingReview} ligne(s) non rapprochée(s)`);
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
    if (isLimitChange||isFunding) {
      if (!token) return notify("Session distante expirée : reconnectez-vous");
      try {
        const apiResponse = await fetch(`${API}/requests/${id}/decision`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ decision: accepted ? "APPROVED" : "REJECTED", reason: reason || undefined }),
        });
        if (!apiResponse.ok) throw new Error(await apiResponse.text());
        if (accepted) setCards((current) => current.map((item) => item.id === String(request.carteId ?? "") || item.masked_card_number === String(request.carte) ? { ...item, monthly_limit: Number(request.plafond) } : item));
        setData((current) => ({ ...current, requests: current.requests.map((item) => item.id === id ? { ...item, statut: accepted ? "VALIDEE_ZIN" : "REFUSEE_ZIN", motif: reason || (accepted ? "Validée" : "Refusée") } : item) }));
        notify(accepted ? `${isFunding?"Alimentation":"Plafond"} de la carte ${request.carte} validée à ${Number(request.plafond).toLocaleString("fr-FR")}` : `Demande ${isFunding?"d’alimentation":"d’augmentation"} refusée`);
      } catch {
        notify("Échec de la décision distante : aucune modification enregistrée");
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
  function deleteRow(
    section: "transactions" | "vehicles" | "beneficiaries",
    id?: string,
  ) {
    if (!user || !canManage(user.role))
      return notify("Najib dispose d’un accès en consultation uniquement");
    if (section === "vehicles" && id) {
      const vehicle = data.vehicles.find((row) => row.id === id);
      const registration = String(vehicle?.immatriculation ?? "").trim().toLowerCase();
      if (registration && cards.some((card) => String(card.registration ?? "").trim().toLowerCase() === registration))
        return notify("Suppression impossible : ce véhicule est encore lié à une carte. Modifiez d’abord l’affectation de la carte.");
    }
    const label = id ? "cet enregistrement" : "toutes les transactions";
    if (!window.confirm(`Confirmer la suppression de ${label} ?`)) return;
    const next = {
      ...data,
      [section]: id ? data[section].filter((row) => row.id !== id) : [],
    };
    setData(next);
    persist(cards, next);
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
    const card = cards.find((item) => item.masked_card_number === String(row.carte));
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
    const beneficiary = String(f.get("beneficiary") ?? "").trim();
    const vehicle = String(f.get("vehicle") ?? "").trim();
    const amount = parseNumeric(f.get("amount"));
    const originalAmount = parseNumeric(allocationRow.montant);
    const alreadyAllocated = parseNumeric(allocationRow.montantReparti);
    const remaining = Math.max(0, originalAmount - alreadyAllocated);
    if (!beneficiary) return notify("Le poseur est obligatoire");
    if (!vehicle) return notify("La matricule du véhicule est obligatoire");
    if (amount <= 0 || amount > remaining) return notify("Le montant réparti doit être positif et ne peut pas dépasser le reste");
    if(!token)return notify("Session distante expirée");
    let pendingAllocationId="";try{const response=await fetch(`${API}/transactions/${allocationRow.id}/allocations`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({beneficiary,vehicle,amount,note:"Répartition hebdomadaire du responsable hors parc"})});if(!response.ok)throw new Error(await response.text());const created=await response.json();pendingAllocationId=String(created.id);}catch{return notify("La répartition n’a pas été enregistrée dans la base");}
    const allocation = `${beneficiary} — ${vehicle} — ${amount.toFixed(3)} DT`;
    const next = { ...data, transactions: data.transactions.map((item) => item.id === allocationRow.id ? {
      ...item,
      montantReparti: alreadyAllocated,
      repartitionEnAttente:pendingAllocationId,
      repartition: item.repartition ? `${item.repartition} | ${allocation}` : allocation,
      derniereRepartition: new Date().toLocaleString("fr-MA"),
    } : item) };
    setData(next); persist(cards, next);
    setAllocationRow(null);
    notify(`Répartition envoyée pour validation Zin/DG. Total original inchangé : ${originalAmount.toFixed(3)} DT`);
  }
  const cardConsumption = (card: Card) =>
    data.transactions
      .filter((row) => String(row.carte) === card.masked_card_number)
      .reduce((total, row) => total + parseNumeric(row.montant), 0);
  const consumptionRate = (card: Card) =>
    card.monthly_limit > 0
      ? Math.min(100, Math.round((cardConsumption(card) / card.monthly_limit) * 100))
      : 0;
  const cardsForUser =
    user?.role === "NAJIB_ASSIGNER"
      ? cards.filter((card) => card.card_category === "OFF_PARK")
      : cards;
  function openNotifications(notification: Notification) {
    const next = notifications.map((n) =>
      n.id === notification.id ? { ...n, read: true } : n,
    );
    setNotifications(next);
    persist(cards, data, next);
    if (token && !notification.read)
      fetch(`${API}/notifications/${notification.id}/read`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    setShowNotifications(false);
    setView(notification.view);
  }
  function openCard(card: Card) {
    setSelected(card);
    setModal("cardAction");
  }
  function resolveAnomaly(id: string) {
    const next = {
      ...data,
      anomalies: data.anomalies.map((x) =>
        x.id === id ? { ...x, statut: "Résolue" } : x,
      ),
    };
    setData(next);
    persist(cards, next);
    notify("Anomalie résolue");
  }
  async function decideTransactionReview(id:string,accepted:boolean) {
    if(!token) return notify("Session expirée");
    const reason=accepted?"":window.prompt("Motif du refus","");
    if(!accepted&&!reason?.trim()) return notify("Le motif du refus est obligatoire");
    try { const response=await fetch(`${API}/transactions/reviews/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({decision:accepted?"ACCEPTED":"REJECTED",reason:reason||undefined})}); if(!response.ok) throw new Error(await response.text());
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
  const allNav: [View, string, string][] = [
    ["dashboard", "⌂", "Vue d’ensemble"],
    ["reports", "▥", "Rapports Direction"],
    ["cards", "▣", "Cartes carburant"],
    ["beneficiaries", "♙", "Bénéficiaires"],
    ["vehicles", "◇", "Véhicules"],
    ["drivers", "♙", "Chauffeurs"],
    ["transactions", "↗", "Transactions"],
    ["requests", "☷", "Demandes"],
    ["mileage", "⌁", "Kilométrage"],
    ["fuelPrices", "⛽", "Prix carburants"],
    ["anomalies", "△", "Anomalies"],
  ];
  const nav =
    user.role === "NAJIB_ASSIGNER"
      ? allNav.filter(([v]) =>
          ["dashboard", "cards", "vehicles", "drivers", "transactions", "requests", "mileage", "fuelPrices"].includes(v),
        )
      : isDirection(user.role)
        ? allNav
        : allNav.filter(([v]) => v !== "reports");
  const userNotifications = notifications.filter((n) => n.target === user.role),
    unread = userNotifications.filter((n) => !n.read).length;
  return (
    <div className={styles.app}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span>Δ</span>
          <div>
            Delta<strong>Carburant</strong>
          </div>
        </div>
        <nav>
          {nav.map((n) => (
            <button
              key={n[0]}
              className={view === n[0] ? styles.active : ""}
              onClick={() => {
                setView(n[0]);
                setSearch("");
              }}
            >
              {n[1]} <span>{n[2]}</span>
            </button>
          ))}
        </nav>
        <div className={styles.sideBottom}>
          <button onClick={() => setView("settings")}>
            ⚙ <span>Paramètres</span>
          </button>
          <button onClick={logout}>
            ↪ <span>Déconnexion</span>
          </button>
        </div>
      </aside>
      <main className={styles.content}>
        <header>
          <div>
            <p className={styles.eyebrow}>
              ESPACE {roleLabel(user.role).toUpperCase()} · DONNÉES SYNCHRONISÉES
            </p>
            <h1>{viewMeta[view][0]}</h1>
            <p>{viewMeta[view][1]}</p>
          </div>
          <div className={styles.headerActions}>
            <div className={styles.notificationBox}>
              <button
                className={styles.bell}
                onClick={() => setShowNotifications(!showNotifications)}
              >
                🔔{unread > 0 && <span>{unread}</span>}
              </button>
              {showNotifications && (
                <div className={styles.notificationMenu}>
                  <h3>Notifications</h3>
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
                    <p>Aucune notification</p>
                  )}
                </div>
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
            summary={summary}
            cards={cardsForUser}
            transactions={data.transactions}
            user={user}
            go={setView}
            open={setModal}
            edit={openCard}
          />
        ) : view === "reports" ? (
          <DirectionReports cards={cards} transactions={data.transactions} />
        ) : view === "settings" ? (
          <Settings
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
          />
        )}
      </main>
      {allocationRow && user?.role === "NAJIB_ASSIGNER" && (() => {
        const original = parseNumeric(allocationRow.montant);
        const allocated = parseNumeric(allocationRow.montantReparti);
        const remaining = Math.max(0, original - allocated);
        const poseurs = Array.from(new Set([
          ...cardsForUser.map((card) => card.beneficiary),
          ...data.beneficiaries.map((row) => String(row.nom ?? "")),
        ].filter(Boolean) as string[]));
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
                  Poseur bénéficiaire
                  <input name="beneficiary" list="poseurs-list" placeholder="Choisir ou saisir le poseur" required />
                  <datalist id="poseurs-list">{poseurs.map((name) => <option value={name} key={name} />)}</datalist>
                </label>
                <label>
                  Matricule du véhicule
                  <select name="vehicle" required defaultValue="">
                    <option value="" disabled>Choisir dans le parc automobile</option>
                    {availableVehicles.map((vehicle) => (
                      <option value={String(vehicle.immatriculation)} key={String(vehicle.id)}>
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
                  <span>La transaction originale reste inchangée. Le responsable enregistre sa répartition par poseur et véhicule avec une traçabilité complète.</span>
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
          cards={cards}
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
                    try {
                      const response=await fetch(`${API}/vehicles/${values.id}`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({companyId:company.id,registration,brand:String(values.reference??"")||undefined,model:String(values.type),active:String(values.statut??"Actif")!=="Inactif"})});
                      if(!response.ok)throw new Error(await response.text());
                    } catch(error) {
                      return notify(error instanceof Error?error.message:"La modification du véhicule n’a pas été enregistrée");
                    }
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
                  notify("Modification enregistrée");
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
  summary,
  cards,
  transactions,
  user,
  go,
  open,
  edit,
}: {
  summary: Record<string, number>;
  cards: Card[];
  transactions: Row[];
  user: User;
  go: (v: View) => void;
  open: (m: Modal) => void;
  edit: (c: Card) => void;
}) {
  return (
    <>
      <section className={styles.metrics}>
        <Metric
          icon="▣"
          color="green"
          label="Cartes actives"
          value={summary.activeCards}
          note={`${summary.totalCards} cartes au total`}
        />
        <Metric
          icon="⛽"
          color="blue"
          label="Consommation importée"
          value={`${summary.liters.toLocaleString("fr-FR")} L`}
          note={`${summary.amount.toLocaleString("fr-FR")} MAD`}
        />
        <Metric
          icon="✓"
          color="violet"
          label="À valider par Zin"
          value={summary.pending}
          note="Affectations financières"
        />
        <Metric
          icon="!"
          color="orange"
          label="Oppositions"
          value={summary.opposed}
          note="Perdues, volées ou opposées"
        />
      </section>
      <section className={styles.grid}>
        <CardTable cards={cards.slice(0, 5)} transactions={transactions} user={user} edit={edit} />
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
                icon="＋"
                title="Nouvelle carte"
                sub="Créer une carte"
                onClick={() => open("card")}
              />
            )}
            {canConfirm(user.role) && (
              <Action
                icon="✓"
                title="Validations finance"
                sub={`${summary.pending} carte(s) à confirmer`}
                onClick={() => go("cards")}
              />
            )}
            {canAssign(user.role) && (
              <Action
                icon="⇄"
                title="Affecter une carte"
                sub="Choisir une carte disponible"
                onClick={() => go("cards")}
              />
            )}
            <Action
              icon="⛽"
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
function DirectionReports({
  cards,
  transactions,
}: {
  cards: Card[];
  transactions: Row[];
}) {
  const [scenario, setScenario] = useState<"migration" | "new">("migration");
  const [company, setCompany] = useState("Toutes"),
    [beneficiary, setBeneficiary] = useState("Tous");
  const filteredCards = cards.filter(
    (c) =>
      (company === "Toutes" || c.company_code === company) &&
      (beneficiary === "Tous" || c.beneficiary === beneficiary),
  );
  const filteredTx = transactions.filter((t) =>
    filteredCards.some((c) => c.masked_card_number === String(t.carte)),
  );
  const liters = (rows: Row[]) =>
    rows.reduce((n, r) => n + parseNumeric(r.litres), 0);
  const old = filteredCards.filter((c) => !c.old_card_id),
    fresh = filteredCards.filter((c) => c.old_card_id);
  const oldLiters = liters(
    filteredTx.filter((t) =>
      old.some((c) => c.masked_card_number === String(t.carte)),
    ),
  );
  const newLiters = liters(
    filteredTx.filter((t) =>
      fresh.some((c) => c.masked_card_number === String(t.carte)),
    ),
  );
  const active = filteredCards.filter((c) => c.status === "ACTIVE").length,
    limit = filteredCards
      .filter((c) => c.status === "ACTIVE")
      .reduce((n, c) => n + c.monthly_limit, 0);
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
  return (
    <section className={styles.reportShell}>
      <div className={styles.reportTitle}>
        <span>Δ DeltaCarburant</span>
        <h2>
          {scenario === "migration"
            ? "SCÉNARIO 1 — PILOTAGE MIGRATION CARTES CARBURANT"
            : "SCÉNARIO 2 — SUIVI DES NOUVELLES CARTES"}
        </h2>
        <b>Direction Générale</b>
      </div>
      <div className={styles.reportTabs}>
        <button
          className={scenario === "migration" ? styles.reportActive : ""}
          onClick={() => setScenario("migration")}
        >
          Migration cartes
        </button>
        <button
          className={scenario === "new" ? styles.reportActive : ""}
          onClick={() => setScenario("new")}
        >
          Nouvelles cartes
        </button>
      </div>
      <div className={styles.reportLayout}>
        <div>
          <div className={styles.reportKpis}>
            {scenario === "migration" ? (
              <>
                <ReportKpi
                  label="CONSO ANCIENNES CARTES"
                  value={`${oldLiters.toFixed(0)} L`}
                />
                <ReportKpi
                  label="CONSO NOUVELLES CARTES"
                  value={`${newLiters.toFixed(0)} L`}
                />
                <ReportKpi label="NB CARTES MIGRÉES" value={fresh.length} />
                <ReportKpi
                  label="TAUX DE MIGRATION"
                  value={`${old.length ? Math.round((fresh.length / old.length) * 100) : 0} %`}
                />
              </>
            ) : (
              <>
                <ReportKpi
                  label="CONSO NOUVELLES CARTES"
                  value={`${newLiters.toFixed(0)} L`}
                />
                <ReportKpi label="NB CARTES ACTIVES" value={active} />
                <ReportKpi
                  label="PLAFOND TOTAL"
                  value={`${limit.toLocaleString("fr-FR")} TND`}
                />
                <ReportKpi
                  label="TAUX D’UTILISATION"
                  value={`${utilization} %`}
                />
              </>
            )}
          </div>
          {scenario === "migration" ? (
            <MigrationReport cards={filteredCards} transactions={filteredTx} />
          ) : (
            <NewCardsReport
              cards={filteredCards}
              transactions={filteredTx}
              bars={byBeneficiary}
            />
          )}
        </div>
        <aside className={styles.reportFilters}>
          <h3>⚱ Filtres</h3>
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
            <select>
              <option>Tous</option>
              <option>Ressources humaines</option>
              <option>Moyen commun</option>
              <option>Technique</option>
            </select>
          </label>
          <label>
            Statut
            <select>
              <option>Tous</option>
              <option>Active</option>
              <option>Remplacée</option>
              <option>Opposée</option>
            </select>
          </label>
          <button
            onClick={() => {
              setCompany("Toutes");
              setBeneficiary("Tous");
            }}
          >
            Effacer les filtres
          </button>
        </aside>
      </div>
    </section>
  );
}
function ReportKpi({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <article>
      <small>{label}</small>
      <strong>{value}</strong>
    </article>
  );
}
function Bars({ items }: { items: { name: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((x) => x.value));
  return (
    <div className={styles.bars}>
      {items.map((x) => (
        <div key={x.name}>
          <span>{x.name}</span>
          <i>
            <b style={{ width: `${(x.value / max) * 100}%` }} />
          </i>
          <em>{x.value.toFixed(0)} L</em>
        </div>
      ))}
    </div>
  );
}
function MigrationReport({
  cards,
  transactions,
}: {
  cards: Card[];
  transactions: Row[];
}) {
  const links = cards.filter((c) => c.replacement_card_id);
  const byCompany = [...new Set(cards.map((c) => c.company_code))].map(
    (name) => ({
      name,
      value: transactions
        .filter((t) =>
          cards.some(
            (c) =>
              c.company_code === name &&
              c.masked_card_number === String(t.carte),
          ),
        )
        .reduce((n, t) => n + parseNumeric(t.litres), 0),
    }),
  );
  return (
    <div className={styles.reportGrid}>
      <article>
        <h3>CORRESPONDANCE ANCIENNE CARTE → NOUVELLE CARTE</h3>
        {links.length ? (
          links.map((c) => (
            <div className={styles.migrationLink} key={c.id}>
              <b>{c.masked_card_number}</b>
              <span>⟶</span>
              <b>
                {
                  cards.find((x) => x.id === c.replacement_card_id)
                    ?.masked_card_number
                }
              </b>
            </div>
          ))
        ) : (
          <p>Aucune migration dans ce filtre</p>
        )}
      </article>
      <article>
        <h3>CONSOMMATION PAR SOCIÉTÉ</h3>
        <Bars items={byCompany} />
      </article>
      <article>
        <h3>TOP BÉNÉFICIAIRES</h3>
        <Bars
          items={[
            ...new Set(cards.map((c) => c.beneficiary).filter(Boolean)),
          ].map((name) => ({
            name: String(name),
            value: transactions
              .filter((t) => t.beneficiaire === name)
              .reduce((n, t) => n + parseNumeric(t.litres), 0),
          }))}
        />
      </article>
      <article>
        <h3>CORRESPONDANCE DES CARTES</h3>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>ANCIENNE</th>
                <th>NOUVELLE</th>
                <th>BÉNÉFICIAIRE</th>
                <th>DÉPARTEMENT</th>
                <th>STATUT</th>
              </tr>
            </thead>
            <tbody>
              {links.map((c) => (
                <tr key={c.id}>
                  <td>{c.masked_card_number}</td>
                  <td>
                    {
                      cards.find((x) => x.id === c.replacement_card_id)
                        ?.masked_card_number
                    }
                  </td>
                  <td>{c.beneficiary}</td>
                  <td>{c.department}</td>
                  <td>Active</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}
function NewCardsReport({
  cards,
  transactions,
  bars,
}: {
  cards: Card[];
  transactions: Row[];
  bars: { name: string; value: number }[];
}) {
  return (
    <div className={styles.reportGrid}>
      <article>
        <h3>CONSOMMATION PAR BÉNÉFICIAIRE</h3>
        <Bars items={bars} />
      </article>
      <article>
        <h3>CONSOMMATION QUOTIDIENNE</h3>
        <div className={styles.dailyChart}>
          {transactions.slice(0, 18).map((t, i) => (
            <i
              key={t.id}
              style={{
                height: `${25 + ((parseNumeric(t.litres) + i * 9) % 100)}px`,
              }}
            />
          ))}
        </div>
      </article>
      <article>
        <h3>RÉPARTITION PAR SOCIÉTÉ</h3>
        <Bars
          items={[...new Set(cards.map((c) => c.company_code))].map((name) => ({
            name,
            value: transactions
              .filter((t) =>
                cards.some(
                  (c) =>
                    c.company_code === name &&
                    c.masked_card_number === String(t.carte),
                ),
              )
              .reduce((n, t) => n + parseNumeric(t.litres), 0),
          }))}
        />
      </article>
      <article>
        <h3>DÉTAILS DES TRANSACTIONS</h3>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>CARTE</th>
                <th>BÉNÉFICIAIRE</th>
                <th>STATION</th>
                <th>DATE</th>
                <th>PRODUIT</th>
                <th>VOLUME</th>
                <th>MONTANT</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td>{t.carte}</td>
                  <td>{t.beneficiaire}</td>
                  <td>{t.station}</td>
                  <td>{t.date}</td>
                  <td>{t.produit}</td>
                  <td>{t.litres}</td>
                  <td>{t.montant}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
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
  deleteRow,
  editVehicle,
  resolve,
  decideReview,
  decideMileage,
  decideAllocation,
  decideRequest,
  cancelRequest,
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
}) {
  const [selectedCompany,setSelectedCompany]=useState("Toutes");
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
        "societe",
        "mise_en_circulation",
        "titulaire",
        "echeance_credit",
        "affectation",
        "reference",
        "conducteur",
        "carte",
        "statut",
      ],
    },
    drivers:{button:"Nouveau chauffeur",modal:"driver",cols:["societe","nom","cin","telephone","permis","vehicules","statut"]},
    fuelPrices:{button:"Nouveau prix",modal:"fuelPrice",cols:["societe","produit","ancienPrix","nouveauPrix","variation","date","auteur"]},
    transactions: {
      button: "Importer Excel Total",
      modal: "import",
      cols: [
        "date",
        "carte",
        "beneficiaire",
        "vehicule",
        "station",
        "produit",
        "litres",
        "montant",
        "typeCarte",
        "reparti",
        "detailRepartition",
        "statut",
        "fichier",
      ],
    },
    requests: {
      button: "Nouvelle demande",
      modal: "request",
      cols: [
        "numero",
        "type",
        "beneficiaire",
        "departement",
        "voiture",
        "plafond",
        "carte",
        "carteSource",
        "statut",
        "motif",
        "suivi",
        "recu",
      ],
    },
    mileage:{button:"Nouveau relevé hebdomadaire",modal:"mileage",cols:["semaine","vehicule","societe","responsable","precedent","distanceDetectee","attendu","kilometrage","anomalie","statut","validateur"]},
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
        ? cards.filter((x) => x.card_category === "OFF_PARK")
        : cards;
    const companyChoices=[...new Set(visibleCards.map(x=>x.company_code).filter(Boolean))];
    const filtered = visibleCards.filter((x) =>
      (selectedCompany==="Toutes"||x.company_code===selectedCompany)&&Object.values(x).join(" ").toLowerCase().includes(search.toLowerCase()),
    );
    return (
      <section className={styles.fullPanel}>
        <Toolbar
          search={search}
          setSearch={setSearch}
          button={canCreate(user.role) ? c.button : ""}
          click={() => open("card")}
        />
        {canManage(user.role)&&<label className={styles.companyFilter}>Société <select value={selectedCompany} onChange={event=>setSelectedCompany(event.target.value)}><option>Toutes</option>{companyChoices.map(company=><option key={company}>{company}</option>)}</select></label>}
        <CardTable cards={filtered} transactions={data.transactions} full user={user} edit={edit} />
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
  const fleetRegistrations = new Set(
    data.vehicles.map((row) => String(row.immatriculation).toLowerCase()),
  );
  const vehicleRows: Row[] = [
    ...data.vehicles.map((row) => {
      const linkedCard = cards.find(
        (card) =>
          String(card.registration).toLowerCase() ===
          String(row.immatriculation).toLowerCase(),
      );
      return {
        ...row,
        carte: linkedCard?.masked_card_number ?? "—",
        statut: linkedCard
          ? linkedCard.status === "ACTIVE"
            ? "Actif · carte liée"
            : `${row.statut} · ${status(linkedCard.status)}`
          : row.statut,
      };
    }),
    ...cards
      .filter(
        (card) =>
          card.registration &&
          !fleetRegistrations.has(String(card.registration).toLowerCase()),
      )
      .map((card, index) => ({
        id: `vehicle-card-${card.id}`,
        numero: `AUTO-${index + 1}`,
        immatriculation: String(card.registration),
        type: String(card.vehicle_model ?? "À compléter"),
        societe: card.company_code,
        mise_en_circulation: "À compléter",
        titulaire: "À compléter",
        echeance_credit: "À compléter",
        affectation: card.company_code,
        reference: String(card.vehicle_model ?? "À compléter"),
        conducteur: String(card.beneficiary ?? "Non affecté"),
        carte: card.masked_card_number,
        statut: card.status === "ACTIVE" ? "Actif · carte liée" : status(card.status),
      })),
  ];
  const transactionRows: Row[] = data.transactions.map((row) => {
    const card = cards.find((item) => item.masked_card_number === String(row.carte));
    const allocated = parseNumeric(row.montantReparti);
    return { ...row, typeCarte: card?.card_category === "OFF_PARK" ? "Hors parc" : "Personnalisée", reparti: `${allocated.toFixed(3)} DT`, detailRepartition: row.repartition || "Non répartie" };
  });
  const sourceRows = view === "beneficiaries" ? beneficiaryRows : view === "vehicles" ? vehicleRows : view === "transactions" ? transactionRows : (data[view] ?? []);
  const companyChoices=[...new Set((view==="vehicles"?vehicleRows:cards.map(card=>({societe:card.company_code}))).map(row=>String(row.societe??"")).filter(Boolean))];
  const rows = sourceRows.filter((x) =>
    (view!=="vehicles"||selectedCompany==="Toutes"||String(x.societe)===selectedCompany)&&
    Object.values(x).join(" ").toLowerCase().includes(search.toLowerCase()),
  );
  const button =
    view === "requests"
      ? user.role === "NAJIB_ASSIGNER"
        ? c.button
        : ""
      : view === "mileage"
        ? user.role === "NAJIB_ASSIGNER" ? c.button : ""
      : view === "transactions"
        ? canManage(user.role)
          ? c.button
          : ""
        : view === "vehicles"
          ? canManage(user.role) ? c.button : ""
        : view === "drivers" || view === "fuelPrices"
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
      {(view === "beneficiaries" || view === "vehicles" || view === "drivers") && (
        <div className={styles.importNotice}>
          <b>{view === "vehicles" ? "Référentiel du parc automobile" : view==="drivers"?"Chauffeurs par société":"Module alimenté automatiquement"}</b>
          <span>{view === "vehicles"
            ? canManage(user.role)
              ? "Vous pouvez ajouter, corriger et archiver les véhicules. Les cartes liées restent synchronisées par matricule."
              : "Consultation uniquement. Les véhicules sont gérés par Zin Finance et la Direction Générale."
            : view==="drivers"?"Chaque chauffeur appartient à une société et peut être relié aux véhicules de cette même société."
            : "Les données proviennent des cartes confirmées et de leurs affectations. Aucun ajout manuel n’est nécessaire."}</span>
        </div>
      )}
      <Toolbar
        search={search}
        setSearch={setSearch}
        button={button}
        click={() => (c.modal ? open(c.modal) : download(rows, view))}
      />
      {view==="vehicles"&&canManage(user.role)&&<label className={styles.companyFilter}>Société <select value={selectedCompany} onChange={event=>setSelectedCompany(event.target.value)}><option>Toutes</option>{companyChoices.map(company=><option key={company}>{company}</option>)}</select></label>}
      {view === "transactions" && canManage(user.role) && rows.length > 0 && (
        <div className={styles.bulkBar}>
          <span>{rows.length} transaction(s)</span>
          <button onClick={() => deleteRow("transactions")}>
            Supprimer toutes les transactions
          </button>
        </div>
      )}
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              {c.cols.map((x) => (
                <th key={x}>{x.toUpperCase()}</th>
              ))}
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                {c.cols.map((k) => (
                  <td key={k}>{r[k] ?? "—"}</td>
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
                  ) : view === "requests" && r.statut === "VALIDEE_ZIN" && r.recu !== "—" ? (
                    <button className={styles.smallBtn} onClick={()=>printReceipt(r)}>Imprimer reçu PDF</button>
                  ) : view === "anomalies" && r.statut === "À vérifier" ? (
                    <><button className={styles.smallBtn} onClick={()=>decideReview(r.id,true)}>Accepter</button>{" "}<button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={()=>decideReview(r.id,false)}>Refuser</button></>
                  ) : view === "anomalies" && r.statut !== "Résolue" && r.statut !== "Acceptée" && r.statut !== "Refusée" ? (
                    <button className={styles.smallBtn} onClick={() => resolve(r.id)}>Résoudre</button>
                  ) : view === "mileage" && canManage(user.role) && r.statut === "EN_ATTENTE_ZIN" ? (
                    <><button className={styles.smallBtn} onClick={()=>decideMileage(r.id,true)}>Valider</button>{" "}<button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={()=>decideMileage(r.id,false)}>Refuser</button></>
                  ) : view === "transactions" && r.reviewId ? (
                    canManage(user.role) ? <><button className={styles.smallBtn} onClick={()=>decideReview(String(r.reviewId),true)}>Accepter et créer/lier</button>{" "}<button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={()=>decideReview(String(r.reviewId),false)}>Déclarer inexistante</button></> : <span>En attente de Zin / DG</span>
                  ) : view === "transactions" ? (
                    user.role === "NAJIB_ASSIGNER" ? (
                      <button className={styles.smallBtn} onClick={() => allocateConsumption(r)}>Répartir</button>
                    ) : canManage(user.role) ? (
                      <>
                        {r.repartitionEnAttente&&<><button className={styles.smallBtn} onClick={()=>decideAllocation(String(r.repartitionEnAttente),true)}>Valider répartition</button>{" "}<button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={()=>decideAllocation(String(r.repartitionEnAttente),false)}>Refuser répartition</button>{" "}</>}
                        <button
                          className={styles.smallBtn}
                          onClick={() => editTransaction(r)}
                        >
                          Corriger
                        </button>{" "}
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
                    canManage(user.role) && !String(r.id).startsWith("vehicle-card-") ? <>
                      <button className={styles.smallBtn} onClick={() => editVehicle(r)}>Modifier</button>{" "}
                      <button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={() => deleteRow("vehicles", r.id)}>Supprimer</button>
                    </> : <span>Consultation</span>
                  ) : view === "drivers" || view === "fuelPrices" ? (
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
  button,
  click,
}: {
  search: string;
  setSearch: (s: string) => void;
  button: string;
  click: () => void;
}) {
  return (
    <div className={styles.toolbar}>
      <input
        placeholder="Rechercher dans la liste…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {button && <button onClick={click}>＋ {button}</button>}
    </div>
  );
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
              <th>PLAFOND</th>
              <th>STATUT</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => {
              const cardTransactions = transactions.filter(
                (row) => String(row.carte) === c.masked_card_number,
              );
              // Le plafond est mensuel : le cumul affiché doit donc provenir du
              // calcul mensuel de l'API, et non de toutes les lignes chargées.
              const consumed = Number(c.consumed_amount ?? 0);
              const allocations = allocationDetails(cardTransactions);
              const allocated = allocations.reduce((sum, item) => sum + item.amount, 0);
              const rate = c.monthly_limit > 0 ? Math.min(100, Math.round(consumed / c.monthly_limit * 100)) : 0;
              const previous = c.old_card_id ? cards.find((item) => item.id === c.old_card_id) : undefined;
              const previousConsumed = Number(previous?.consumed_amount ?? 0);
              const previousRate = previous?.monthly_limit ? Math.min(100, Math.round(previousConsumed / previous.monthly_limit * 100)) : 100;
              const locked = Boolean(c.activation_locked && previousRate < 100);
              return (
              <Fragment key={c.id}>
              <tr>
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
                  {c.monthly_limit.toLocaleString("fr-FR")} TND
                  <small>
                    Consommé : {consumed.toLocaleString("fr-FR")} TND · {rate}%
                    {" · "}Solde : {Math.max(0, c.monthly_limit-consumed).toLocaleString("fr-FR")} TND
                  </small>
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
                    <button className={styles.smallBtn} onClick={() => edit(c)}>
                      {canConfirm(user.role) && c.finance_status === "PENDING"
                        ? "Vérifier"
                        : "Gérer"}
                    </button>
                  )}
                </td>
              </tr>
              {user.role === "NAJIB_ASSIGNER" && c.card_category === "OFF_PARK" && (
                <tr className={styles.allocationRow}>
                  <td colSpan={7}>
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
  const [selectedRegistration, setSelectedRegistration] = useState("");
  const [requestType, setRequestType] = useState<"NEW_CARD" | "LIMIT_CHANGE" | "CARD_FUNDING">("NEW_CARD");
  const [requestCardId, setRequestCardId] = useState("");
  const requestCards = cards.filter((item) => ["ACTIVE","TO_ASSIGN"].includes(item.status));
  const requestCard = requestCards.find((item) => item.id === requestCardId);
  const eligibleFundingSources=requestCards.filter(item=>item.status==="ACTIVE"&&item.id!==requestCardId&&Number(item.monthly_limit)>0&&Number(item.consumption_rate??0)>=60);
  const selectedVehicle = selectableVehicles.find(
    (row) => String(row.immatriculation) === selectedRegistration,
  );
  const [action, setAction] = useState(
    card && canAssign(user.role) && card.status === "TO_ASSIGN"
      ? "assign"
      : "distributed",
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
                    <option value="distributed">
                      Marquer comme distribuée
                    </option>
                    <option value="LOST">Déclarer perdue</option>
                    <option value="STOLEN">Déclarer volée</option>
                    <option value="replace">Lier une carte remplaçante</option>
                  </>
                )}
                {canManage(user.role)&&<option value="responsible">Attribuer à un responsable hors parc</option>}
                {canConfirm(user.role) && (
                  <>
                    <option value="oppose">Mettre en opposition</option>
                    <option value="confirm">Valider l’affectation</option>
                    <option value="reject">Refuser la validation</option>
                    <option value="block">Bloquer la carte</option>
                    <option value="unblock">Débloquer / réactiver</option>
                  </>
                )}
                {(isDirection(user.role) || user.role === "ZIN_FINANCE") && (
                  <option value="delete">Archiver la carte</option>
                )}
              </select>
            </label>
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
            {action==="responsible"&&<label className={styles.fullField}>Responsable hors parc<select name="responsibleUserId" required defaultValue={card?.responsible_user_id??""}><option value="" disabled>Sélectionner un responsable</option>{responsibles.map(item=><option value={item.id} key={item.id}>{item.name} · {item.email}</option>)}</select></label>}
            {["LOST", "STOLEN", "oppose", "replace"].includes(action) && (
              <label className={styles.fullField}>
                Motif / observation
                <textarea name="reason" required />
              </label>
            )}
            <div className={styles.workflowInfo}>
              <b>Règle appliquée</b>
              <span>
                {action === "replace"
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
                  <select name="typeDemande" value={requestType} onChange={(event) => { setRequestType(event.target.value as "NEW_CARD" | "LIMIT_CHANGE" | "CARD_FUNDING"); setRequestCardId(""); }}>
                    <option value="NEW_CARD">Demande de nouvelle carte</option>
                    <option value="CARD_FUNDING">Alimentation d’une carte disponible</option>
                    <option value="LIMIT_CHANGE">Demande d’augmentation de plafond</option>
                  </select>
                </label>
                {requestType === "LIMIT_CHANGE" || requestType === "CARD_FUNDING" ? (
                  <>
                    <label className={styles.fullField}>
                      {requestType === "CARD_FUNDING" ? "Carte à alimenter disponible dans votre espace" : "Carte disponible dans la base"}
                      <select name="carteId" required value={requestCardId} onChange={(event) => setRequestCardId(event.target.value)}>
                        <option value="" disabled>Sélectionner une carte active</option>
                        {requestCards.map((item) => <option value={item.id} key={item.id}>{item.masked_card_number} · plafond actuel {item.monthly_limit.toLocaleString("fr-FR")}</option>)}
                      </select>
                    </label>
                    {requestType === "CARD_FUNDING" && <><label className={styles.fullField}>Carte source ayant consommé au moins 60 % ce mois-ci<select name="carteSourceId" required defaultValue=""><option value="" disabled>{eligibleFundingSources.length?"Sélectionner la carte source":"Aucune carte admissible"}</option>{eligibleFundingSources.map(item=><option value={item.id} key={item.id}>{item.masked_card_number} · consommation {Number(item.consumption_rate??0).toFixed(0)} %</option>)}</select></label>{!eligibleFundingSources.length&&<div className={styles.workflowInfo}><b>Alimentation indisponible</b><span>Vos cartes avec un plafond valide n’ont pas encore dépassé 60 % de consommation ce mois-ci. Attendez le dépassement du seuil ou demandez à Zin / la DG de définir le plafond.</span></div>}</>}
                    {requestCard && <div className={styles.workflowInfo}><b>Plafond actuel</b><span>{requestCard.monthly_limit.toLocaleString("fr-FR")}</span></div>}
                    <input type="hidden" name="beneficiaire" value={requestCard?.beneficiary ?? "Najib"} />
                    <input type="hidden" name="departement" value={requestCard?.department ?? "Hors parc"} />
                    <input type="hidden" name="voiture" value={requestCard?.registration ?? "Sans véhicule"} />
                  </>
                ) : (
                  <>
                    <label>Bénéficiaire<input name="beneficiaire" required /></label>
                    <label>Département<input name="departement" required /></label>
                    <label>Voiture / immatriculation<select name="voiture" required defaultValue=""><option value="" disabled>Sélectionner une matricule</option>{selectableVehicles.map((vehicle) => <option value={String(vehicle.immatriculation)} key={String(vehicle.id)}>{String(vehicle.immatriculation)} · {String(vehicle.type)} · {String(vehicle.reference)}</option>)}</select></label>
                  </>
                )}
                <label>Plafond demandé<input name="plafond" type="number" min={requestType === "LIMIT_CHANGE" ? (requestCard?.monthly_limit ?? 0) + 0.001 : 0} step="0.001" required /></label>
                <label className={styles.fullField}>Motif de la demande<input name="motif" required minLength={3} /></label>
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
            {type === "mileage" && <><label className={styles.fullField}>Véhicule de votre périmètre<select name="vehicleId" required defaultValue=""><option value="" disabled>Sélectionner un véhicule</option>{vehicles.map(vehicle=><option value={String(vehicle.id)} key={String(vehicle.id)}>{String(vehicle.immatriculation)} · dernier relevé {Number(vehicle.kilometrage??0).toLocaleString("fr-FR")} km</option>)}</select></label><label>Nouveau kilométrage<input name="mileage" type="number" min="0" step="0.1" required /></label><label>Observation<input name="note" /></label><div className={styles.workflowInfo}><b>Contrôle automatique</b><span>La plateforme compare le relevé au dernier kilométrage validé augmenté de la distance détectée dans les transactions. Tout écart est envoyé à Zin et à la DG.</span></div></>}
            {type==="driver"&&<><label>Société<select name="companyId" required defaultValue=""><option value="" disabled>Sélectionner</option>{companies.map(item=><option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label><label>Nom complet<input name="fullName" required minLength={2}/></label><label>CIN<input name="cin"/></label><label>Téléphone<input name="phone"/></label><label className={styles.fullField}>Numéro de permis<input name="licenseNumber"/></label></>}
            {type==="fuelPrice"&&<><label>Société<select name="companyId" required defaultValue=""><option value="" disabled>Sélectionner</option>{companies.map(item=><option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label><label>Produit<input name="product" placeholder="Gasoil" required/></label><label>Nouveau prix / litre<input name="newPrice" type="number" min="0.001" step="0.001" required/></label><label>Date d’effet<input name="effectiveDate" type="date"/></label><div className={styles.workflowInfo}><b>Ajustement automatique</b><span>La variation du prix est appliquée dans la même proportion à tous les plafonds actifs de la société, avec audit et notifications.</span></div></>}
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
                  Aucune transaction ne sera créée manuellement. Les doublons du
                  fichier Total seront détectés et ignorés.
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
  return (
    <main className={styles.login}>
      <section>
        <div className={styles.loginBrand}>
          <span>Δ</span>
          <div>
            Delta<strong>Carburant</strong>
          </div>
        </div>
        <h1>Bienvenue</h1>
        <p>Connectez-vous avec vos identifiants professionnels.</p>
        <form onSubmit={onSubmit}>
          <label>
            Adresse e-mail
            <input
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Mot de passe
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && <div className={styles.loginError}>{error}</div>}
          <button disabled={loading}>
            {loading ? "Connexion…" : "Se connecter"}
          </button>
        </form>
      </section>
      <aside>
        <div className={styles.orb}>Δ</div>
        <h2>
          Un workflow clair.
          <br />
          Une responsabilité par rôle.
        </h2>
        <p>Gérez les cartes carburant et suivez les opérations en toute sécurité.</p>
      </aside>
    </main>
  );
}
function Settings({ reset }: { reset: () => void }) {
  return (
    <section className={styles.settings}>
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
function Metric({
  icon,
  color,
  label,
  value,
  note,
}: {
  icon: string;
  color: string;
  label: string;
  value: string | number;
  note: string;
}) {
  return (
    <article className={styles.metric}>
      <div className={`${styles.metricIcon} ${styles[color]}`}>{icon}</div>
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
  icon: string;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick}>
      <i>{icon}</i>
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
  const rawCard = String(totalValue(source, [
    "numerodumodedepaiement", "numeromodedepaiement", "numerodecarte", "numerocarte", "ncarte", "cardnumber",
  ]));
  const digits = rawCard.replace(/\D/g, "");
  const quantity = totalValue(source, [
    "quantite",
    "volume",
    "litres",
    "quantity",
  ]);
  const amount = totalValue(source, ["montant", "montantttc", "amount", "totalttc"]);
  const rawDate=totalValue(source, ["datetransaction", "dateoperation", "date"]);
  const rawTime=totalValue(source,["heuredelatransaction","heuretransaction","heure"]);
  const excelDate=typeof rawDate==="number"?XLSX.SSF.parse_date_code(rawDate):null;
  const parsedDate=rawDate instanceof Date?new Date(rawDate):excelDate?new Date(Date.UTC(excelDate.y,excelDate.m-1,excelDate.d,excelDate.H,excelDate.M,Math.floor(excelDate.S))):new Date(String(rawDate));
  const timeMatch=String(rawTime??"").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(!Number.isNaN(parsedDate.getTime())&&timeMatch) parsedDate.setHours(Number(timeMatch[1]),Number(timeMatch[2]),Number(timeMatch[3]??0),0);
  return {
    id: `total-${filename}-${index}-${crypto.randomUUID()}`,
    date: displayDate(rawDate),
    dateApi: Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString(),
    carte: digits || rawCard || "Carte non reconnue",
    station: String(
      totalValue(source, [
        "stationservice",
        "station",
        "site",
        "pointdevente",
      ]) || "—",
    ),
    vehicule: String(totalValue(source,["plaquedimmatriculation","immatriculation","matriculevehicule","vehicle","registration"])||""),
    beneficiaire: String(totalValue(source,["beneficiaire","chauffeur","conducteur","nomduchauffeur","titulaire","nomdutitulaire"])||""),
    produit: String(totalValue(source,["nomdeproduit","nomduproduit","produit","product","carburant"])||"Carburant"),
    kilometragePrecedent: parseNumeric(totalValue(source,["kilometrageprecedent"])),
    kilometrage: parseNumeric(totalValue(source,["kilometrage"])),
    codeAutorisation: String(totalValue(source,["codedautorisation","codeautorisation","numerodetransaction"])||""),
    litres: `${String(quantity || "0")} L`,
    montant: `${String(amount || "0")} MAD`,
    statut: "Importée Total",
    fichier: filename,
    source: "TOTAL_EXCEL",
  };
}
function transactionKey(row: Row) {
  return [row.date, row.carte, row.station, row.litres, row.montant]
    .join("|")
    .toLowerCase();
}
function parseNumeric(value: unknown) {
  return (
    Number(
      String(value ?? 0)
        .replace(/[^0-9,.-]/g, "")
        .replace(",", "."),
    ) || 0
  );
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

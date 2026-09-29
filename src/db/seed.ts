import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';
import { closeDb, getDb, inTransaction, nowIso } from './connection.js';
import { migrate } from './migrate.js';
import { ROLES, ROLE_DEFINITIONS, type RoleKey } from '../config/rbac.js';
import { nextReference } from '../utils/reference.js';
import { assertTransferableStock, postLedgerEntry } from '../services/stockService.js';
import { logger } from '../utils/logger.js';

/**
 * Deterministic demo dataset.
 *
 * Everything is generated relative to today, so the dashboard always opens on a
 * populated current month. Figures are chosen to exercise every reporting path:
 * a base with an opening balance and no movement, transfers in both directions,
 * an in-flight transfer, partial returns, and write-offs against both an
 * assignment and base stock directly.
 */

const dayMs = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * dayMs).toISOString().slice(0, 10);
const monthStart = (offsetMonths: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1)).toISOString().slice(0, 10);
};
const currentPeriod = monthStart(0);
const previousPeriod = monthStart(-1);

export function seed(): void {
  migrate();
  const db = getDb();

  if (config.db.file !== ':memory:') {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    if (existing.n > 0) {
      logger.warn('Database already contains users - skipping seed. Use `npm run db:reset` to start over.');
      return;
    }
  }

  inTransaction((tx) => {
    // ------------------------------------------------------------- roles ----
    const roleIds = new Map<RoleKey, number>();
    const insertRole = tx.prepare('INSERT INTO roles (key, name, description, scope) VALUES (?, ?, ?, ?)');
    for (const definition of Object.values(ROLE_DEFINITIONS)) {
      const info = insertRole.run(definition.key, definition.name, definition.description, definition.scope);
      roleIds.set(definition.key, Number(info.lastInsertRowid));
    }

    // ------------------------------------------------------------- bases ----
    const insertBase = tx.prepare(
      'INSERT INTO bases (code, name, location, country, commander) VALUES (?, ?, ?, ?, ?)',
    );
    const bases = [
      ['FWK-01', 'Forward Operating Base Kilo', 'Kabul Province, Afghanistan', 'Afghanistan', 'Col. R. Adeyemi'],
      ['CMP-02', 'Camp Meridian', 'Diyarbakir, Türkiye', 'Türkiye', 'Lt. Col. M. Halvorsen'],
      ['RWS-03', 'Regional Warehouse South', 'Rotterdam, Netherlands', 'Netherlands', 'Lt. Col. S. Okonkwo'],
      ['FOB-04', 'Forward Operating Base Lima', 'Aleppo, Syria', 'Syria', 'Lt. Col. D. Ferreira'],
    ] as const;
    const baseIds = new Map<string, number>();
    for (const [code, name, location, country, commander] of bases) {
      const info = insertBase.run(code, name, location, country, commander);
      baseIds.set(code, Number(info.lastInsertRowid));
    }

    // ---------------------------------------------------- equipment types ---
    const insertEquipment = tx.prepare(
      `INSERT INTO equipment_types (code, name, category, unit, serialised, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const equipment = [
      ['EQ-WPN-556', 'Rifle 5.56mm', 'WEAPON', 'weapons', 1, 'Standard service rifle, individual issue'],
      ['EQ-WPN-762', 'Machine gun 7.62mm', 'WEAPON', 'weapons', 1, 'General-purpose support weapon'],
      ['EQ-veh-hmmwv', 'HMMWV 4x4', 'VEHICLE', 'vehicles', 1, 'Light tactical vehicle'],
      ['EQ-VEH-trk', 'Cargo truck 5t', 'VEHICLE', 'vehicles', 1, 'Medium logistics truck'],
      ['EQ-amm-762', 'Ammunition 7.62x51mm', 'AMMUNITION', 'rounds', 0, 'Belted general-purpose ammunition'],
      ['EQ-amm-556', 'Ammunition 5.56x45mm', 'AMMUNITION', 'rounds', 0, 'Standard rifle ammunition'],
      ['EQ-eqp-comms', 'Manpack radio (AN/PRC-152)', 'EQUIPMENT', 'sets', 1, 'Long-range tactical radio'],
      ['EQ-spr-tire', 'Vehicle tyre 11R18.5', 'SPARES', 'tyres', 0, 'Heavy vehicle spare tyre'],
    ] as const;
    const equipmentIds = new Map<string, number>();
    for (const [code, name, category, unit, serialised, description] of equipment) {
      const info = insertEquipment.run(code, name, category, unit, serialised, description);
      equipmentIds.set(code, Number(info.lastInsertRowid));
    }

    // -------------------------------------------------------------- users ---
    const insertUser = tx.prepare(
      `INSERT INTO users (username, email, full_name, rank, password_hash, role_id, base_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const addUser = (username: string, fullName: string, rank: string, role: RoleKey, baseCode: string | null) => {
      const hash = bcrypt.hashSync(SEED_PASSWORD[role], config.auth.bcryptRounds);
      const info = insertUser.run(
        username,
        `${username}@milams.example`,
        fullName,
        rank,
        hash,
        roleIds.get(role)!,
        baseCode ? baseIds.get(baseCode)! : null,
      );
      return Number(info.lastInsertRowid);
    };

    const adminId = addUser(config.seed.adminUsername, config.seed.adminName, 'CIV (Grade A)', ROLES.ADMIN, null);
    const commanderKilo = addUser('cmd.kilo', 'Col. R. Adeyemi', 'Colonel', ROLES.BASE_COMMANDER, 'FWK-01');
    const commanderMeridian = addUser('cmd.meridian', 'Lt. Col. M. Halvorsen', 'Lieutenant Colonel', ROLES.BASE_COMMANDER, 'CMP-02');
    addUser('log.kilo', 'Capt. J. Nwosu', 'Captain', ROLES.LOGISTICS_OFFICER, 'FWK-01');
    addUser('log.meridian', '2/Lt. P. Larsen', 'Second Lieutenant', ROLES.LOGISTICS_OFFICER, 'CMP-02');
    addUser('log.warehouse', 'Sgt. M. Duarte', 'Sergeant', ROLES.LOGISTICS_OFFICER, 'RWS-03');
    addUser('cmd.lima', 'Lt. Col. D. Ferreira', 'Lieutenant Colonel', ROLES.BASE_COMMANDER, 'FOB-04');

    // ----------------------------------------------------------- personnel ---
    const insertPersonnel = tx.prepare(
      'INSERT INTO personnel (service_number, full_name, rank, unit, base_id) VALUES (?, ?, ?, ?, ?)',
    );
    const addPersonnel = (serviceNumber: string, name: string, rank: string, unit: string, baseCode: string) => {
      const info = insertPersonnel.run(serviceNumber, name, rank, unit, baseIds.get(baseCode)!);
      return Number(info.lastInsertRowid);
    };

    const personnel = {
      kiloSquad: [
        ['AF-10231', 'Sgt. T. Abubakar', 'Sergeant', '1st Platoon, A Company'],
        ['AF-10232', 'Cpl. R. Nkemelu', 'Corporal', '1st Platoon, A Company'],
        ['AF-10233', 'Pvt. J. Halvorsen', 'Private', '1st Platoon, A Company'],
        ['AF-10455', 'Sgt. M. Petrov', 'Sergeant', 'Weapons Platoon'],
      ],
      meridian: [
        ['AF-20871', 'Cpl. H. Yilmaz', 'Corporal', '2nd Platoon, B Company'],
        ['AF-20872', 'Pvt. A. Rossi', 'Private', '2nd Platoon, B Company'],
        ['AF-20990', 'Sgt. K. Mbeki', 'Sergeant', 'Transport Section'],
      ],
      warehouse: [['AF-31001', 'Cpl. N. Bergstrom', 'Corporal', 'Stores Detachment']],
      lima: [['AF-41200', 'Sgt. F. Haddad', 'Sergeant', '1st Platoon, C Company']],
    } as const;

    const pKilo = personnel.kiloSquad.map(([sn, name, rank, unit]) => addPersonnel(sn, name, rank, unit, 'FWK-01'));
    const pMeridian = personnel.meridian.map(([sn, name, rank, unit]) => addPersonnel(sn, name, rank, unit, 'CMP-02'));
    const pWarehouse = personnel.warehouse.map(([sn, name, rank, unit]) => addPersonnel(sn, name, rank, unit, 'RWS-03'));
    pMeridian.push(...personnel.lima.map(([sn, name, rank, unit]) => addPersonnel(sn, name, rank, unit, 'FOB-04')));

    // ======================================================== TRANSACTIONS ===
    // Author ids double as the actor recorded on each ledger line.
    const author = { admin: adminId, kilo: commanderKilo, meridian: commanderMeridian, logistics: adminId };

    // --- opening balances, previous month (the starting position) -----------
    const insertOpening = tx.prepare(
      `INSERT INTO opening_balances (base_id, equipment_type_id, period_start, quantity, recorded_by, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const postOpening = (baseCode: string, equipmentCode: string, quantity: number, notes: string) => {
      const baseId = baseIds.get(baseCode)!;
      const equipmentTypeId = equipmentIds.get(equipmentCode)!;
      const info = insertOpening.run(baseId, equipmentTypeId, previousPeriod, quantity, author.admin, notes);
      const id = Number(info.lastInsertRowid);
      postLedgerEntry(tx, {
        baseId,
        equipmentTypeId,
        txnType: 'OPENING_BALANCE',
        refType: 'OPENING_BALANCE',
        refId: id,
        refReference: `OB-${previousPeriod.slice(0, 4)}`,
        quantity,
        deltaOnHand: quantity,
        effectiveDate: previousPeriod,
        note: notes,
        actorId: author.admin,
      });
    };

    postOpening('FWK-01', 'EQ-WPN-556', 180, 'Weapons readiness figure, opening of period');
    postOpening('FWK-01', 'EQ-WPN-762', 14, 'Support weapons, opening of period');
    postOpening('FWK-01', 'EQ-veh-hmmwv', 22, 'Fleet strength at start of period');
    postOpening('FWK-01', 'EQ-amm-762', 24_000, 'Ammunition stockpile at start of period');
    postOpening('FWK-01', 'EQ-amm-556', 31_500, 'Ammunition stockpile at start of period');
    postOpening('FWK-01', 'EQ-eqp-comms', 26, 'Comms equipment on strength');
    postOpening('FWK-01', 'EQ-spr-tire', 60, 'Tyre spares held');

    postOpening('CMP-02', 'EQ-WPN-556', 240, 'Weapons readiness figure, opening of period');
    postOpening('CMP-02', 'EQ-WPN-762', 22, 'Support weapons, opening of period');
    postOpening('CMP-02', 'EQ-veh-hmmwv', 38, 'Fleet strength at start of period');
    postOpening('CMP-02', 'EQ-VEH-trk', 26, 'Lift capacity at start of period');
    postOpening('CMP-02', 'EQ-amm-762', 48_000, 'Ammunition stockpile at start of period');
    postOpening('CMP-02', 'EQ-amm-556', 62_000, 'Ammunition stockpile at start of period');
    postOpening('CMP-02', 'EQ-eqp-comms', 44, 'Comms equipment on strength');
    postOpening('CMP-02', 'EQ-spr-tire', 24, 'Tyre spares held for the vehicle fleet');

    postOpening('RWS-03', 'EQ-veh-hmmwv', 64, 'Regional holding, opening of period');
    postOpening('RWS-03', 'EQ-VEH-trk', 40, 'Regional holding, opening of period');
    postOpening('RWS-03', 'EQ-amm-762', 120_000, 'Central ammunition reserve');
    postOpening('RWS-03', 'EQ-amm-556', 150_000, 'Central ammunition reserve');
    postOpening('RWS-03', 'EQ-spr-tire', 240, 'Tyre spares held centrally');

    postOpening('FOB-04', 'EQ-WPN-556', 96, 'Weapons readiness figure, opening of period');
    postOpening('FOB-04', 'EQ-veh-hmmwv', 12, 'Fleet strength at start of period');
    postOpening('FOB-04', 'EQ-amm-762', 9_000, 'Ammunition stockpile at start of period');
    postOpening('FOB-04', 'EQ-spr-tire', 18, 'Tyre spares held');

    // --- purchases ---------------------------------------------------------
    const insertPurchase = tx.prepare(
      `INSERT INTO purchases
         (reference, base_id, equipment_type_id, quantity, unit_cost, supplier, contract_ref,
          purchase_date, received_date, status, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?, ?)`,
    );
    const raisePurchase = (args: {
      baseCode: string;
      equipmentCode: string;
      quantity: number;
      unitCost: number;
      supplier: string;
      contractRef: string;
      purchaseDate: string;
      receivedDate: string;
      notes: string;
      actorId: number;
    }) => {
      const baseId = baseIds.get(args.baseCode)!;
      const equipmentTypeId = equipmentIds.get(args.equipmentCode)!;
      const reference = nextReference(tx, 'PURCHASE', args.receivedDate);
      const info = insertPurchase.run(
        reference,
        baseId,
        equipmentTypeId,
        args.quantity,
        args.unitCost,
        args.supplier,
        args.contractRef,
        args.purchaseDate,
        args.receivedDate,
        args.notes,
        args.actorId,
        nowIso(),
        nowIso(),
      );
      const id = Number(info.lastInsertRowid);
      postLedgerEntry(tx, {
        baseId,
        equipmentTypeId,
        txnType: 'PURCHASE',
        refType: 'PURCHASE',
        refId: id,
        refReference: reference,
        quantity: args.quantity,
        deltaOnHand: args.quantity,
        effectiveDate: args.receivedDate,
        note: `Goods received from ${args.supplier}`,
        actorId: args.actorId,
      });
    };

    // Purchases in the *previous* month give the current month's opening
    // balance somewhere to come from (roll-forward), which is what the
    // reconciliation query has to get right.
    raisePurchase({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-amm-762',
      quantity: 12_000,
      unitCost: 185,
      supplier: 'Nordic Ammunition Group',
      contractRef: 'NAG-2025-114',
      purchaseDate: iso(-38),
      receivedDate: iso(-34),
      notes: 'Resupply round, delivered against FY schedule',
      actorId: author.admin,
    });
    raisePurchase({
      baseCode: 'CMP-02',
      equipmentCode: 'EQ-veh-hmmwv',
      quantity: 8,
      unitCost: 1_450_000,
      supplier: 'Oshkosh Defence',
      contractRef: 'OSH-2025-902',
      purchaseDate: iso(-35),
      receivedDate: iso(-30),
      notes: 'Fleet replacement programme',
      actorId: author.admin,
    });

    // Current-month receipts.
    raisePurchase({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-amm-556',
      quantity: 18_000,
      unitCost: 92,
      supplier: 'Nordic Ammunition Group',
      contractRef: 'NAG-2026-007',
      purchaseDate: iso(-21),
      receivedDate: iso(-18),
      notes: 'Quarterly ammunition resupply',
      actorId: author.admin,
    });
    raisePurchase({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-spr-tire',
      quantity: 24,
      unitCost: 48_000,
      supplier: 'Continental Tyre Group',
      contractRef: 'CTG-2026-051',
      purchaseDate: iso(-16),
      receivedDate: iso(-12),
      notes: 'Tyre spares for the vehicle fleet',
      actorId: author.admin,
    });
    raisePurchase({
      baseCode: 'CMP-02',
      equipmentCode: 'EQ-amm-762',
      quantity: 20_000,
      unitCost: 185,
      supplier: 'Nordic Ammunition Group',
      contractRef: 'NAG-2026-011',
      purchaseDate: iso(-19),
      receivedDate: iso(-14),
      notes: 'Replacement of expended training ammunition',
      actorId: author.admin,
    });
    raisePurchase({
      baseCode: 'CMP-02',
      equipmentCode: 'EQ-eqp-comms',
      quantity: 12,
      unitCost: 620_000,
      supplier: 'Thales Defence',
      contractRef: 'THA-2026-022',
      purchaseDate: iso(-11),
      receivedDate: iso(-7),
      notes: 'Manpack radio refresh for the signal platoon',
      actorId: author.admin,
    });
    raisePurchase({
      baseCode: 'RWS-03',
      equipmentCode: 'EQ-amm-762',
      quantity: 60_000,
      unitCost: 182,
      supplier: 'Nordic Ammunition Group',
      contractRef: 'NAG-2026-014',
      purchaseDate: iso(-13),
      receivedDate: iso(-9),
      notes: 'Central reserve build-up ahead of the rotation',
      actorId: author.admin,
    });
    raisePurchase({
      baseCode: 'FOB-04',
      equipmentCode: 'EQ-amm-556',
      quantity: 6_000,
      unitCost: 95,
      supplier: 'Nordic Ammunition Group',
      contractRef: 'NAG-2026-016',
      purchaseDate: iso(-8),
      receivedDate: iso(-5),
      notes: 'Top-up following increased tempo',
      actorId: author.admin,
    });

    // --- transfers ---------------------------------------------------------
    const insertTransfer = tx.prepare(
      `INSERT INTO transfers
         (reference, from_base_id, to_base_id, status, transfer_date, received_date,
          dispatched_by, received_by, vehicle_ref, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTransferItem = tx.prepare(
      'INSERT INTO transfer_items (transfer_id, equipment_type_id, quantity, quantity_received) VALUES (?, ?, ?, ?)',
    );

    /**
     * Two legs, one reference. Stock leaves on dispatch and arrives on receipt,
     * exactly as the API does it, so the seeded history is indistinguishable
     * from history created through the UI.
     */
    const raiseTransfer = (args: {
      from: string;
      to: string;
      date: string;
      receivedDate: string | null;
      vehicleRef: string;
      notes: string;
      actorId: number;
      lines: { equipmentCode: string; quantity: number }[];
    }) => {
      const fromBaseId = baseIds.get(args.from)!;
      const toBaseId = baseIds.get(args.to)!;
      const completed = args.receivedDate !== null;
      const reference = nextReference(tx, 'TRANSFER', args.date);

      const info = insertTransfer.run(
        reference,
        fromBaseId,
        toBaseId,
        completed ? 'COMPLETED' : 'IN_TRANSIT',
        args.date,
        args.receivedDate,
        args.actorId,
        completed ? args.actorId : null,
        args.vehicleRef,
        args.notes,
        args.actorId,
        nowIso(),
        nowIso(),
      );
      const transferId = Number(info.lastInsertRowid);

      for (const line of args.lines) {
        const equipmentTypeId = equipmentIds.get(line.equipmentCode)!;
        // Same availability rule the API enforces, so the seeded history could
        // not have been produced through the UI if it were impossible.
        assertTransferableStock(tx, fromBaseId, equipmentTypeId, line.quantity, 'transfer out');
        insertTransferItem.run(
          transferId,
          equipmentTypeId,
          line.quantity,
          completed ? line.quantity : null,
        );

        postLedgerEntry(tx, {
          baseId: fromBaseId,
          equipmentTypeId,
          txnType: 'TRANSFER_OUT',
          refType: 'TRANSFER',
          refId: transferId,
          refReference: reference,
          quantity: line.quantity,
          deltaOnHand: -line.quantity,
          effectiveDate: args.date,
          note: `Dispatched to ${args.to}`,
          actorId: args.actorId,
        });

        if (completed) {
          postLedgerEntry(tx, {
            baseId: toBaseId,
            equipmentTypeId,
            txnType: 'TRANSFER_IN',
            refType: 'TRANSFER',
            refId: transferId,
            refReference: reference,
            quantity: line.quantity,
            deltaOnHand: line.quantity,
            effectiveDate: args.receivedDate!,
            note: `Received from ${args.from}`,
            actorId: args.actorId,
          });
        }
      }
    };

    // Previous month: a completed movement, so the current month's opening
    // balance is a roll-forward rather than the raw recorded figure.
    raiseTransfer({
      from: 'RWS-03',
      to: 'FWK-01',
      date: iso(-32),
      receivedDate: iso(-29),
      vehicleRef: 'CONVOY-CR-118',
      notes: 'Central reserve issue against the FY resupply plan',
      actorId: author.admin,
      lines: [
        { equipmentCode: 'EQ-amm-762', quantity: 8_000 },
        { equipmentCode: 'EQ-spr-tire', quantity: 12 },
      ],
    });

    // Current month: completed, in both directions.
    raiseTransfer({
      from: 'RWS-03',
      to: 'FWK-01',
      date: iso(-15),
      receivedDate: iso(-13),
      vehicleRef: 'CONVOY-CR-204',
      notes: 'Replacement tyres and a top-up of 5.56mm',
      actorId: author.admin,
      lines: [
        { equipmentCode: 'EQ-spr-tire', quantity: 20 },
        { equipmentCode: 'EQ-amm-556', quantity: 4_000 },
      ],
    });
    raiseTransfer({
      from: 'FWK-01',
      to: 'CMP-02',
      date: iso(-10),
      receivedDate: iso(-8),
      vehicleRef: 'CONVOY-CR-211',
      notes: 'Rebalancing of 7.62mm support ammunition',
      actorId: author.kilo,
      lines: [{ equipmentCode: 'EQ-amm-762', quantity: 6_000 }],
    });
    raiseTransfer({
      from: 'CMP-02',
      to: 'FOB-04',
      date: iso(-6),
      receivedDate: iso(-4),
      vehicleRef: 'CONVOY-CR-219',
      notes: 'Support to the northern outstation',
      actorId: author.meridian,
      lines: [
        { equipmentCode: 'EQ-amm-556', quantity: 3_000 },
        { equipmentCode: 'EQ-spr-tire', quantity: 6 },
      ],
    });

    // Still on the road: the source base's closing balance is already reduced,
    // the destination's is not yet increased. This is the state the dashboard
    // has to represent honestly.
    raiseTransfer({
      from: 'RWS-03',
      to: 'CMP-02',
      date: iso(-2),
      receivedDate: null,
      vehicleRef: 'CONVOY-CR-233',
      notes: 'Heavy equipment uplift - awaiting arrival confirmation',
      actorId: author.admin,
      lines: [
        { equipmentCode: 'EQ-VEH-trk', quantity: 6 },
        { equipmentCode: 'EQ-veh-hmmwv', quantity: 4 },
      ],
    });

    // --- assignments -------------------------------------------------------
    const insertAssignment = tx.prepare(
      `INSERT INTO assignments
         (reference, base_id, equipment_type_id, personnel_id, quantity, quantity_returned,
          quantity_expended, status, assigned_date, due_date, returned_date, purpose, notes,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const raiseAssignment = (args: {
      baseCode: string;
      equipmentCode: string;
      personnelId: number;
      quantity: number;
      date: string;
      dueDate: string | null;
      purpose: string;
      notes: string;
      actorId: number;
    }) => {
      const baseId = baseIds.get(args.baseCode)!;
      const equipmentTypeId = equipmentIds.get(args.equipmentCode)!;
      const reference = nextReference(tx, 'ASSIGNMENT', args.date);
      const info = insertAssignment.run(
        reference,
        baseId,
        equipmentTypeId,
        args.personnelId,
        args.quantity,
        0,
        0,
        'ACTIVE',
        args.date,
        args.dueDate,
        null,
        args.purpose,
        args.notes,
        args.actorId,
        nowIso(),
        nowIso(),
      );
      const id = Number(info.lastInsertRowid);
      // Issuing does not change on-hand; it raises the committed figure.
      postLedgerEntry(tx, {
        baseId,
        equipmentTypeId,
        txnType: 'ASSIGNMENT',
        refType: 'ASSIGNMENT',
        refId: id,
        refReference: reference,
        quantity: args.quantity,
        deltaOnHand: 0,
        deltaCommitted: args.quantity,
        effectiveDate: args.date,
        note: args.purpose,
        actorId: args.actorId,
      });
      return { id, reference, baseId, equipmentTypeId };
    };

    const returnAssignment = (args: {
      assignment: { id: number; reference: string; baseId: number; equipmentTypeId: number };
      quantity: number;
      date: string;
      note: string;
      actorId: number;
    }) => {
      const current = tx
        .prepare('SELECT quantity, quantity_returned, quantity_expended FROM assignments WHERE id = ?')
        .get(args.assignment.id) as { quantity: number; quantity_returned: number; quantity_expended: number };

      const returned = current.quantity_returned + args.quantity;
      const outstanding = current.quantity - returned - current.quantity_expended;
      const status = outstanding === 0 ? 'RETURNED' : 'PARTIALLY_RETURNED';

      tx.prepare(
        `UPDATE assignments
            SET quantity_returned = ?, status = ?, returned_date = ?, notes = notes || ' | ' || ?, updated_at = ?
          WHERE id = ?`,
      ).run(returned, status, args.date, args.note, nowIso(), args.assignment.id);

      postLedgerEntry(tx, {
        baseId: args.assignment.baseId,
        equipmentTypeId: args.assignment.equipmentTypeId,
        txnType: 'RETURN',
        refType: 'ASSIGNMENT',
        refId: args.assignment.id,
        refReference: args.assignment.reference,
        quantity: args.quantity,
        deltaOnHand: 0,
        deltaCommitted: -args.quantity,
        effectiveDate: args.date,
        note: args.note,
        actorId: args.actorId,
      });
    };

    raiseAssignment({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-WPN-556',
      personnelId: pKilo[0]!,
      quantity: 1,
      date: iso(-24),
      dueDate: iso(6),
      purpose: 'Individual weapon, permanent issue',
      notes: 'Service rifle held on the establishment',
      actorId: author.kilo,
    });    raiseAssignment({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-WPN-556',
      personnelId: pKilo[1]!,
      quantity: 1,
      date: iso(-24),
      dueDate: iso(6),
      purpose: 'Individual weapon, permanent issue',
      notes: 'Service rifle held on the establishment',
      actorId: author.kilo,
    });
    const asnGPMG = raiseAssignment({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-WPN-762',
      personnelId: pKilo[3]!,
      quantity: 2,
      date: iso(-20),
      dueDate: null,
      purpose: 'Weapons platoon support guns',
      notes: 'Squad automatic weapon, section equipment',
      actorId: author.kilo,
    });
    const asnRadio = raiseAssignment({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-eqp-comms',
      personnelId: pKilo[2]!,
      quantity: 1,
      date: iso(-9),
      dueDate: iso(21),
      purpose: 'Platoon communications',
      notes: 'Manpack radio for the platoon leader',
      actorId: author.kilo,
    });
    returnAssignment({
      assignment: asnRadio,
      quantity: 1,
      date: iso(-3),
      note: 'Returned for battery exchange, returned to strength',
      actorId: author.kilo,
    });

    raiseAssignment({
      baseCode: 'CMP-02',
      equipmentCode: 'EQ-WPN-556',
      personnelId: pMeridian[0]!,
      quantity: 1,
      date: iso(-18),
      dueDate: null,
      purpose: 'Individual weapon, permanent issue',
      notes: 'Service rifle held on the establishment',
      actorId: author.meridian,
    });
    raiseAssignment({
      baseCode: 'CMP-02',
      equipmentCode: 'EQ-VEH-trk',
      personnelId: pMeridian[2]!,
      quantity: 3,
      date: iso(-12),
      dueDate: iso(18),
      purpose: 'Transport section allocation',
      notes: 'Trucks allocated to the movement sub-section',
      actorId: author.meridian,
    });
    raiseAssignment({
      baseCode: 'CMP-02',
      equipmentCode: 'EQ-WPN-762',
      personnelId: pMeridian[1]!,
      quantity: 1,
      date: iso(-5),
      dueDate: null,
      purpose: 'Weapons training, live firing',
      notes: 'Issued for the live firing serial',
      actorId: author.meridian,
    });
    raiseAssignment({
      baseCode: 'FOB-04',
      equipmentCode: 'EQ-WPN-556',
      personnelId: pMeridian[3]!,
      quantity: 1,
      date: iso(-4),
      dueDate: null,
      purpose: 'Individual weapon, permanent issue',
      notes: 'Service rifle held on the establishment',
      actorId: author.admin,
    });
    raiseAssignment({
      baseCode: 'RWS-03',
      equipmentCode: 'EQ-veh-hmmwv',
      personnelId: pWarehouse[0]!,
      quantity: 2,
      date: iso(-2),
      dueDate: null,
      purpose: 'Stores handling vehicles',
      notes: 'Reserved for stores movement within the depot',
      actorId: author.admin,
    });

    // --- expenditures ------------------------------------------------------
    const insertExpenditure = tx.prepare(
      `INSERT INTO expenditures
         (reference, base_id, equipment_type_id, quantity, source, assignment_id,
          reason, expended_date, authorised_by, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const raiseExpenditure = (args: {
      baseCode: string;
      equipmentCode: string;
      quantity: number;
      source: 'DIRECT' | 'ASSIGNED';
      assignmentId: number | null;
      reason: string;
      date: string;
      authorisedBy: string;
      notes: string;
      actorId: number;
    }) => {
      const baseId = baseIds.get(args.baseCode)!;
      const equipmentTypeId = equipmentIds.get(args.equipmentCode)!;
      const reference = nextReference(tx, 'EXPENDITURE', args.date);
      const info = insertExpenditure.run(
        reference,
        baseId,
        equipmentTypeId,
        args.quantity,
        args.source,
        args.assignmentId,
        args.reason,
        args.date,
        args.authorisedBy,
        args.notes,
        args.actorId,
        nowIso(),
      );
      const id = Number(info.lastInsertRowid);
      postLedgerEntry(tx, {
        baseId,
        equipmentTypeId,
        txnType: 'EXPENDITURE',
        refType: 'EXPENDITURE',
        refId: id,
        refReference: reference,
        quantity: args.quantity,
        deltaOnHand: -args.quantity,
        deltaCommitted: args.source === 'ASSIGNED' ? -args.quantity : 0,
        effectiveDate: args.date,
        note: `${args.reason} - ${args.notes}`,
        actorId: args.actorId,
      });

      // Keep the assignment document in step with the ledger. The ledger line
      // above releases the committed quantity; without this the assignment would
      // still report the consumed units as outstanding, so the "assigned" total
      // derived from documents would disagree with the one derived from the
      // ledger. This mirrors what POST /api/expenditures does.
      if (args.source === 'ASSIGNED' && args.assignmentId !== null) {
        const current = tx
          .prepare('SELECT quantity, quantity_returned, quantity_expended FROM assignments WHERE id = ?')
          .get(args.assignmentId) as {
          quantity: number;
          quantity_returned: number;
          quantity_expended: number;
        };

        const expended = current.quantity_expended + args.quantity;
        const returned = current.quantity_returned;
        const status = returned + expended >= current.quantity ? 'EXPENDED' : 'PARTIALLY_RETURNED';

        tx.prepare(
          `UPDATE assignments SET quantity_expended = ?, status = ?, updated_at = ? WHERE id = ?`,
        ).run(expended, status, nowIso(), args.assignmentId);
      }

      return id;
    };

    // Direct write-offs from base stock (never issued to anyone).
    raiseExpenditure({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-amm-762',
      quantity: 1_850,
      source: 'DIRECT',
      assignmentId: null,
      reason: 'TRAINING',
      date: iso(-17),
      authorisedBy: 'Col. R. Adeyemi',
      notes: 'Live firing serial, weapons qualification course',
      actorId: author.kilo,
    });
    raiseExpenditure({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-amm-556',
      quantity: 2_400,
      source: 'DIRECT',
      assignmentId: null,
      reason: 'COMBAT',
      date: iso(-9),
      authorisedBy: 'Col. R. Adeyemi',
      notes: 'Consumed during contact, replenishment requested',
      actorId: author.kilo,
    });
    raiseExpenditure({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-spr-tire',
      quantity: 7,
      source: 'DIRECT',
      assignmentId: null,
      reason: 'DAMAGE',
      date: iso(-6),
      authorisedBy: 'Lt. Col. D. Ferreira',
      notes: 'Tyres destroyed by contact with debris',
      actorId: author.kilo,
    });
    raiseExpenditure({
      baseCode: 'CMP-02',
      equipmentCode: 'EQ-amm-762',
      quantity: 5_200,
      source: 'DIRECT',
      assignmentId: null,
      reason: 'TRAINING',
      date: iso(-11),
      authorisedBy: 'Lt. Col. M. Halvorsen',
      notes: 'Sustained-fire training serial',
      actorId: author.meridian,
    });
    raiseExpenditure({
      baseCode: 'CMP-02',
      equipmentCode: 'EQ-amm-556',
      quantity: 3_100,
      source: 'DIRECT',
      assignmentId: null,
      reason: 'MAINTENANCE',
      date: iso(-4),
      authorisedBy: 'Lt. Col. M. Halvorsen',
      notes: 'Rounds fired on the maintenance range',
      actorId: author.meridian,
    });
    raiseExpenditure({
      baseCode: 'RWS-03',
      equipmentCode: 'EQ-amm-762',
      quantity: 3_600,
      source: 'DIRECT',
      assignmentId: null,
      reason: 'DECOMMISSIONED',
      date: iso(-7),
      authorisedBy: 'System Administrator',
      notes: 'Lot beyond shelf life, destroyed under policy',
      actorId: author.admin,
    });
    raiseExpenditure({
      baseCode: 'FOB-04',
      equipmentCode: 'EQ-amm-556',
      quantity: 950,
      source: 'DIRECT',
      assignmentId: null,
      reason: 'LOSS',
      date: iso(-3),
      authorisedBy: 'Lt. Col. D. Ferreira',
      notes: 'Unrecovered after a resupply convoy was ambushed',
      actorId: author.admin,
    });

    // Write-off against an open assignment: on-hand and committed both fall, so
    // the "Assigned" KPI decreases by exactly the quantity consumed.
    raiseExpenditure({
      baseCode: 'FWK-01',
      equipmentCode: 'EQ-WPN-762',
      quantity: 1,
      source: 'ASSIGNED',
      assignmentId: asnGPMG.id,
      reason: 'COMBAT',
      date: iso(-5),
      authorisedBy: 'Col. R. Adeyemi',
      notes: 'Weapon destroyed by enemy action, recovered remains',
      actorId: author.kilo,
    });

    // A fully expended assignment: 1x 7.62mm issued for the firing serial, all
    // of it consumed - the lifecycle ends at EXPENDED, not RETURNED.
    const firedAssignment = raiseAssignment({
      baseCode: 'CMP-02',
      equipmentCode: 'EQ-WPN-556',
      personnelId: pMeridian[1]!,
      quantity: 1,
      date: iso(-5),
      dueDate: null,
      purpose: 'Weapons training, live firing',
      notes: 'Issued for the live firing serial',
      actorId: author.meridian,
    });
    raiseExpenditure({
      baseCode: 'CMP-02',
      equipmentCode: 'EQ-WPN-556',
      quantity: 1,
      source: 'ASSIGNED',
      assignmentId: firedAssignment.id,
      reason: 'TRAINING',
      date: iso(-2),
      authorisedBy: 'Lt. Col. M. Halvorsen',
      notes: 'Rifle damaged beyond repair on the live firing serial',
      actorId: author.meridian,
    });
    // The assignment's status is set by raiseExpenditure: the whole issue was
    // consumed, so it closes as EXPENDED.

    // --- this month's opening balance, recorded explicitly for two bases ----
    // FOB-04 deliberately has NO recorded opening balance for the current
    // period, so its figures come purely from the roll-forward - which is the
    // case that proves the reconciliation query is not just reading a column.
    recordCurrentPeriodOpening('CMP-02', 'EQ-VEH-trk', 26, 'Lift capacity carried into the period');
    recordCurrentPeriodOpening('FWK-01', 'EQ-VEH-trk', 0, 'No cargo trucks held at this base');
    recordCurrentPeriodOpening('FWK-01', 'EQ-WPN-556', 0, 'Recount pending weapon inspection');

    /** Declares this period's opening position and posts the matching ledger line. */
    function recordCurrentPeriodOpening(
      baseCode: string,
      equipmentCode: string,
      quantity: number,
      notes: string,
    ): void {
      const baseId = baseIds.get(baseCode)!;
      const equipmentTypeId = equipmentIds.get(equipmentCode)!;
      const info = insertOpening.run(baseId, equipmentTypeId, currentPeriod, quantity, author.admin, notes);
      const id = Number(info.lastInsertRowid);
      if (quantity === 0) return; // a declared zero needs no ledger line

      postLedgerEntry(tx, {
        baseId,
        equipmentTypeId,
        txnType: 'OPENING_BALANCE',
        refType: 'OPENING_BALANCE',
        refId: id,
        refReference: `OB-${currentPeriod.slice(0, 4)}`,
        quantity,
        deltaOnHand: quantity,
        effectiveDate: currentPeriod,
        note: notes,
        actorId: author.admin,
      });
    }
  });

  report();
}

function report(): void {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM roles)             AS roles,
         (SELECT COUNT(*) FROM bases)             AS bases,
         (SELECT COUNT(*) FROM equipment_types)   AS equipment_types,
         (SELECT COUNT(*) FROM users)             AS users,
         (SELECT COUNT(*) FROM personnel)         AS personnel,
         (SELECT COUNT(*) FROM purchases)         AS purchases,
         (SELECT COUNT(*) FROM transfers)         AS transfers,
         (SELECT COUNT(*) FROM assignments)       AS assignments,
         (SELECT COUNT(*) FROM expenditures)      AS expenditures,
         (SELECT COUNT(*) FROM stock_ledger)      AS ledger_entries,
         (SELECT COUNT(*) FROM document_sequences) AS sequences`,
    )
    .get() as Record<string, number>;

  console.log('\nSeed complete');
  console.table(counts);
  console.log('\nDemo accounts (password shown in brackets):');
  for (const line of ACCOUNT_TABLE) console.log(`  ${line}`);
  console.log('\nDatabase:', config.db.file);
}

const SEED_PASSWORD: Record<RoleKey, string> = {
  [ROLES.ADMIN]: config.seed.adminPassword,
  [ROLES.BASE_COMMANDER]: 'Commander@12345',
  [ROLES.LOGISTICS_OFFICER]: 'Logistics@12345',
};

const ACCOUNT_TABLE = [
  `admin          - Administrator (all bases)      [${SEED_PASSWORD[ROLES.ADMIN]}]`,
  'cmd.kilo       - Base Commander, FWK-01        [Commander@12345]',
  'cmd.meridian   - Base Commander, CMP-02        [Commander@12345]',
  'cmd.lima       - Base Commander, FOB-04        [Commander@12345]',
  'log.kilo       - Logistics Officer, FWK-01     [Logistics@12345]',
  'log.meridian   - Logistics Officer, CMP-02     [Logistics@12345]',
  'log.warehouse  - Logistics Officer, RWS-03     [Logistics@12345]',
];

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  try {
    seed();
  } catch (error) {
    console.error('Seeding failed:', error);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

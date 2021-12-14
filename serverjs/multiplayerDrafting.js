/* eslint-disable no-await-in-loop */
const { cardType } = require('../dist/utils/Card');
const {
  hget,
  hmget,
  hmset,
  lpush,
  rpush,
  hgetall,
  lrange,
  expire,
  rpoplpush,
  rpop,
  hincrby,
  del,
  hset,
} = require('./redis');

const { setupPicks, getCardCol, getStepList } = require('../dist/drafting/draftutil');
const { createDeckFromDraft } = require('./deckUtil');

// returns a reference to a draft's metadata hash
const lobbyRef = (draftId) => `lobby:${draftId}`;

// returns a reference to a draft's metadata hash
const lobbyPlayersRef = (draftId) => `lobbylist:${draftId}`;

// returns a reference to a draft's metadata hash
const lobbyOrderRef = (draftId) => `lobbyorder:${draftId}`;

// returns a reference to a draft's metadata hash
const draftRef = (draftId) => `draft:${draftId}`;

// returns a reference to a draft's metadata hash
const draftBotSeatsRef = (draftId) => `draft:${draftId}:botseats`;

// returns a reference to a seat's pack queue
const seatRef = (draftId, seat) => `draft:${draftId}:seat:${seat}`;

const stepsQueueRef = (draftId, seat) => `draft:${draftId}:steps:${seat}`;

// returns a reference to a draft's seating order
const seatsRef = (draftId) => `draft:${draftId}:seats`;

// returns a reference to a draft's current player list
const draftPlayersRef = (draftId) => `draft:${draftId}:players`;

// returns the reference to the initial contents of a pack
const packRef = (draftId, seat, pack) => `draft:${draftId}:pack:${seat}-${pack}`;

// returns the reference to the cards picked from a pack
const pickedRef = (draftId, seat, pack) => `draft:${draftId}:picked:${seat}-${pack}`;

// returns the reference to the cards picked by a user
const userPicksRef = (draftId, seat) => `draft:${draftId}:userpicks:${seat}`;

// returns the reference to the cards trashed by a user
const userTrashRef = (draftId, seat) => `draft:${draftId}:usertrash:${seat}`;

// converts a reference to a pack to a reference of the cards picked from that pack
const packToPicked = (ref) => ref.replace('pack', 'picked');

const nonIntersect = (list1, list2) => list1.filter((x) => !list2.includes(x));

const getPlayerPicks = async (draftId, seat) => lrange(userPicksRef(draftId, seat), 0, -1);
const getPlayerTrash = async (draftId, seat) => lrange(userTrashRef(draftId, seat), 0, -1);

const getDraftMetaData = async (draftId) => {
  const [seats, currentPack, totalPacks, initialized] = await hmget(
    draftRef(draftId),
    'seats',
    'currentPack',
    'totalPacks',
    'initialized',
  );
  return {
    seats: parseInt(seats, 10),
    currentPack: parseInt(currentPack, 10),
    totalPacks: parseInt(totalPacks, 10),
    initialized,
  };
};

const getCurrentPackCards = async (packReference) => {
  const cards = await lrange(packReference, 0, -1);
  const picked = await lrange(packToPicked(packReference), 0, -1);
  return nonIntersect(cards, picked);
};

const getPlayerPackReference = async (draftId, seat) => {
  // get reference to pack and to the cards picked from it
  const packs = await lrange(seatRef(draftId, seat), -1, -1);
  if (packs.length <= 0) {
    return undefined;
  }

  return packs[packs.length - 1];
};

const getPlayerPack = async (draftId, seat) => {
  const ref = await getPlayerPackReference(draftId, seat);
  if (ref === undefined) {
    return [];
  }
  return getCurrentPackCards(ref);
};

const openPack = async (draftId) => {
  // get draft metadata
  const { seats, currentPack, totalPacks } = await getDraftMetaData(draftId);

  if (currentPack < totalPacks) {
    // add the contents of the pack
    for (let i = 0; i < seats; i++) {
      const seat = seatRef(draftId, i);
      await rpop(seat);
      await rpush(seat, packRef(draftId, i, currentPack));
      await expire(seat, 60 * 60 * 24 * 2); // 2 days
    }

    // increment the current pack
    await hincrby(draftRef(draftId), 'currentPack', 1);
  }
};

const getCurrentPackStep = async (draftId, seat) => {
  const [next] = await lrange(stepsQueueRef(draftId, seat), -1, -1);
  return next;
};

const getCurrentPackStepQueue = async (draftId, seat) => {
  const items = await lrange(stepsQueueRef(draftId, seat), 0, -1);
  return items.reverse();
};

const makePick = async (draftId, seat, pick, nextSeat) => {
  // get reference to pack and to the cards picked from it
  const packReference = await getPlayerPackReference(draftId, seat);

  if (!packReference) {
    return; // no pack to pick from
  }

  const packCards = await getCurrentPackCards(packReference);
  const picked = packToPicked(packReference);
  const step = await rpop(stepsQueueRef(draftId, seat));

  console.log(`-----seat ${seat}------`);
  console.log(packCards);
  console.log(pick);
  console.log('-------------------');

  // pick this card if the step is pick
  if (step === 'pick' || step === 'pickrandom') {
    await lpush(userPicksRef(draftId, seat), packCards[pick]);
    await expire(userPicksRef(draftId, seat), 60 * 60 * 24 * 2); // 2 days
  }

  // trash this card if the step is trash
  if (step === 'trash' || step === 'trashrandom') {
    await lpush(userTrashRef(draftId, seat), packCards[pick]);
    await expire(userTrashRef(draftId, seat), 60 * 60 * 24 * 2); // 2 days
  }

  if (packCards.length > 0) {
    // push the card into the picked list
    await lpush(picked, packCards[pick]);
    await expire(picked, 60 * 60 * 24 * 2); // 2 days
  }

  // look if the next action is a pass
  const next = await getCurrentPackStep(draftId, seat);
  if (next === 'pass') {
    // rotate the pack to the next seat
    await rpoplpush(seatRef(draftId, seat), seatRef(draftId, nextSeat));
  }

  while ((await getCurrentPackStep(draftId, seat)) === 'pass') {
    await rpop(stepsQueueRef(draftId, seat));
  }
};

const getPassAmount = async (draftId, seat) => {
  const steps = await lrange(stepsQueueRef(draftId, seat), 0, -1);
  let foundStep = false;
  let passes = 0;

  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i] === 'pass') {
      foundStep = true;
      passes += 1;
    } else if (foundStep) {
      return passes;
    }
  }

  return 0;
};

const isPackDone = async (draftId) => {
  const { seats, currentPack } = await getDraftMetaData(draftId);

  for (let i = 0; i < seats; i++) {
    // get reference to the pack and to the cards picked from it
    const pack = packRef(draftId, i, currentPack - 1);
    const packCards = await getCurrentPackCards(pack);

    if (packCards.length > 0) {
      return false;
    }
  }

  return true;
};

const getDraftBotsSeats = async (draftId) => {
  const indexes = await lrange(draftBotSeatsRef(draftId), 0, -1);
  return indexes.map((i) => parseInt(i, 10));
};

// if all human seats have nothing to pick from, but the draft is not over
const packNeedsBotPicks = async (draftId) => {
  if (await isPackDone(draftId)) {
    return false;
  }

  const { seats } = await getDraftMetaData(draftId);
  const bots = await getDraftBotsSeats(draftId);

  for (let i = 0; i < seats; i++) {
    if (!bots.includes(i)) {
      const packReference = await getPlayerPackReference(draftId, i);

      if (packReference) {
        const packCards = await getCurrentPackCards(packReference);
        if (packCards.length > 0) {
          return false;
        }
      }
    }
  }

  return true;
};

const cleanUp = async (draftId) => {
  // get draft metadata
  const { seats, totalPacks } = await getDraftMetaData(draftId);

  // delete all references
  for (let i = 0; i < seats; i++) {
    await del(seatRef(draftId, i));
    await del(userPicksRef(draftId, i));
    await del(userTrashRef(draftId, i));
    for (let j = 0; j < totalPacks; j++) {
      await del(packRef(draftId, i));
      await del(pickedRef(draftId, i));
    }
  }
};

const finishDraft = async (draftId, draft) => {
  const { seats } = await getDraftMetaData(draftId);
  // set user picks to the actual picks
  for (let i = 0; i < seats; i++) {
    const picks = await getPlayerPicks(draftId, i);
    const trash = await getPlayerTrash(draftId, i);

    draft.seats[i].pickorder = picks;
    draft.seats[i].trashorder = trash;

    const drafted = setupPicks(2, 8);
    const sideboard = setupPicks(1, 8);
    for (const cardIndex of picks) {
      const col = getCardCol(draft, cardIndex);
      const row = cardType(draft.cards[cardIndex]).toLowerCase().includes('creature') ? 0 : 1;
      drafted[row][col].push(parseInt(cardIndex, 10));
    }

    draft.seats[i].sideboard = sideboard;
    draft.seats[i].drafted = drafted;
  }

  await draft.save();
  const deck = await createDeckFromDraft(draft);
  hset(draftRef(draftId), 'finished', true);

  await cleanUp(draftId);

  return deck;
};

const createLobby = async (draft, hostUser) => {
  const lobbylist = lobbyPlayersRef(draft._id);
  const lobbyorder = lobbyOrderRef(draft._id);
  const lobby = lobbyRef(draft._id);

  await hmset(lobby, ['seats', `${draft.seats.length}`, 'host', `${hostUser._id}`]);
  await hmset(lobbyorder, [`${hostUser._id}`, '0']);
  await rpush(lobbylist, `${hostUser._id}`);
};

const getLobbySeatOrder = async (draftId) => hgetall(lobbyOrderRef(draftId));
const getLobbyPlayers = async (draftId) => lrange(lobbyPlayersRef(draftId), 0, -1);
const getLobbyMetadata = async (draftId) => hgetall(lobbyRef(draftId));
const updateLobbySeatOrder = (draftid, order) => hmset(lobbyOrderRef(draftid), Object.entries(order).flat());

const addPlayerToLobby = async (userId, draftId) => {
  await rpush(lobbyPlayersRef(draftId), userId);

  const seatOrder = await getLobbySeatOrder(draftId);
  if (!seatOrder[userId]) {
    let i = 0;
    while (
      Object.entries(seatOrder)
        .map(([, val]) => val)
        .includes(`${i}`)
    ) {
      i += 1;
    }
    await hset(lobbyOrderRef(draftId), `${userId}`, `${i}`);
  }
};

const setup = async (draft) => {
  // check if the draft is already setup
  const initialized = await hget(draftRef(draft.id), 'initialized');

  if (!initialized) {
    // setup the draft metadata
    await hmset(draftRef(draft._id), [
      'seats',
      draft.seats.length,
      'currentPack',
      0,
      'totalPacks',
      draft.initial_state[0].length,
      'initialized',
      true,
      'finished',
      false,
      'state',
      'drafting',
    ]);

    // create a list of steps for each seat
    const stepList = getStepList(draft);
    for (let i = 0; i < draft.seats.length; i++) {
      for (const step of stepList) {
        if (step.action === 'pass') {
          await lpush(stepsQueueRef(draft._id, i), step.action);
        } else {
          await lpush(stepsQueueRef(draft._id, i), step.action);
        }
      }
    }

    // create a pack contents for each pack
    for (let i = 0; i < draft.initial_state.length; i++) {
      for (let j = 0; j < draft.initial_state[i].length; j++) {
        const pack = packRef(draft._id, i, j);
        await rpush(pack, draft.initial_state[i][j].cards);
        await expire(pack, 60 * 60 * 24 * 2); // 2 days
      }
    }

    const seats = await getLobbySeatOrder(draft._id);
    const playerSeats = Object.entries(seats).map(([, val]) => val);

    // save which seats are bot seats
    for (let i = 0; i < draft.seats.length; i++) {
      if (!playerSeats.includes(`${i}`)) {
        await lpush(draftBotSeatsRef(draft._id), i);
      }
    }

    // open the first pack
    await openPack(draft._id);
  }
};

module.exports = {
  setup,
  getDraftMetaData,
  openPack,
  getPlayerPack,
  getPlayerPicks,
  getDraftBotsSeats,
  makePick,
  getPassAmount,
  isPackDone,
  finishDraft,
  seatRef,
  seatsRef,
  draftRef,
  getCurrentPackCards,
  draftPlayersRef,
  createLobby,
  getLobbyPlayers,
  getLobbySeatOrder,
  getLobbyMetadata,
  addPlayerToLobby,
  lobbyPlayersRef,
  lobbyOrderRef,
  updateLobbySeatOrder,
  packNeedsBotPicks,
  getCurrentPackStep,
  getCurrentPackStepQueue,
};

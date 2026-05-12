import { 
    Cell,
    Slice, 
    Address, 
    Builder, 
    beginCell, 
    ComputeError, 
    TupleItem, 
    TupleReader, 
    Dictionary, 
    contractAddress, 
    ContractProvider, 
    Sender, 
    Contract, 
    ContractABI, 
    ABIType,
    ABIGetter,
    ABIReceiver,
    TupleBuilder,
    DictionaryValue
} from '@ton/core';

export type StateInit = {
    $$type: 'StateInit';
    code: Cell;
    data: Cell;
}

export function storeStateInit(src: StateInit) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeRef(src.code);
        b_0.storeRef(src.data);
    };
}

export function loadStateInit(slice: Slice) {
    let sc_0 = slice;
    let _code = sc_0.loadRef();
    let _data = sc_0.loadRef();
    return { $$type: 'StateInit' as const, code: _code, data: _data };
}

function loadTupleStateInit(source: TupleReader) {
    let _code = source.readCell();
    let _data = source.readCell();
    return { $$type: 'StateInit' as const, code: _code, data: _data };
}

function loadGetterTupleStateInit(source: TupleReader) {
    let _code = source.readCell();
    let _data = source.readCell();
    return { $$type: 'StateInit' as const, code: _code, data: _data };
}

function storeTupleStateInit(source: StateInit) {
    let builder = new TupleBuilder();
    builder.writeCell(source.code);
    builder.writeCell(source.data);
    return builder.build();
}

function dictValueParserStateInit(): DictionaryValue<StateInit> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeStateInit(src)).endCell());
        },
        parse: (src) => {
            return loadStateInit(src.loadRef().beginParse());
        }
    }
}

export type StdAddress = {
    $$type: 'StdAddress';
    workchain: bigint;
    address: bigint;
}

export function storeStdAddress(src: StdAddress) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeInt(src.workchain, 8);
        b_0.storeUint(src.address, 256);
    };
}

export function loadStdAddress(slice: Slice) {
    let sc_0 = slice;
    let _workchain = sc_0.loadIntBig(8);
    let _address = sc_0.loadUintBig(256);
    return { $$type: 'StdAddress' as const, workchain: _workchain, address: _address };
}

function loadTupleStdAddress(source: TupleReader) {
    let _workchain = source.readBigNumber();
    let _address = source.readBigNumber();
    return { $$type: 'StdAddress' as const, workchain: _workchain, address: _address };
}

function loadGetterTupleStdAddress(source: TupleReader) {
    let _workchain = source.readBigNumber();
    let _address = source.readBigNumber();
    return { $$type: 'StdAddress' as const, workchain: _workchain, address: _address };
}

function storeTupleStdAddress(source: StdAddress) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.workchain);
    builder.writeNumber(source.address);
    return builder.build();
}

function dictValueParserStdAddress(): DictionaryValue<StdAddress> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeStdAddress(src)).endCell());
        },
        parse: (src) => {
            return loadStdAddress(src.loadRef().beginParse());
        }
    }
}

export type VarAddress = {
    $$type: 'VarAddress';
    workchain: bigint;
    address: Slice;
}

export function storeVarAddress(src: VarAddress) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeInt(src.workchain, 32);
        b_0.storeRef(src.address.asCell());
    };
}

export function loadVarAddress(slice: Slice) {
    let sc_0 = slice;
    let _workchain = sc_0.loadIntBig(32);
    let _address = sc_0.loadRef().asSlice();
    return { $$type: 'VarAddress' as const, workchain: _workchain, address: _address };
}

function loadTupleVarAddress(source: TupleReader) {
    let _workchain = source.readBigNumber();
    let _address = source.readCell().asSlice();
    return { $$type: 'VarAddress' as const, workchain: _workchain, address: _address };
}

function loadGetterTupleVarAddress(source: TupleReader) {
    let _workchain = source.readBigNumber();
    let _address = source.readCell().asSlice();
    return { $$type: 'VarAddress' as const, workchain: _workchain, address: _address };
}

function storeTupleVarAddress(source: VarAddress) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.workchain);
    builder.writeSlice(source.address.asCell());
    return builder.build();
}

function dictValueParserVarAddress(): DictionaryValue<VarAddress> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeVarAddress(src)).endCell());
        },
        parse: (src) => {
            return loadVarAddress(src.loadRef().beginParse());
        }
    }
}

export type Context = {
    $$type: 'Context';
    bounced: boolean;
    sender: Address;
    value: bigint;
    raw: Slice;
}

export function storeContext(src: Context) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeBit(src.bounced);
        b_0.storeAddress(src.sender);
        b_0.storeInt(src.value, 257);
        b_0.storeRef(src.raw.asCell());
    };
}

export function loadContext(slice: Slice) {
    let sc_0 = slice;
    let _bounced = sc_0.loadBit();
    let _sender = sc_0.loadAddress();
    let _value = sc_0.loadIntBig(257);
    let _raw = sc_0.loadRef().asSlice();
    return { $$type: 'Context' as const, bounced: _bounced, sender: _sender, value: _value, raw: _raw };
}

function loadTupleContext(source: TupleReader) {
    let _bounced = source.readBoolean();
    let _sender = source.readAddress();
    let _value = source.readBigNumber();
    let _raw = source.readCell().asSlice();
    return { $$type: 'Context' as const, bounced: _bounced, sender: _sender, value: _value, raw: _raw };
}

function loadGetterTupleContext(source: TupleReader) {
    let _bounced = source.readBoolean();
    let _sender = source.readAddress();
    let _value = source.readBigNumber();
    let _raw = source.readCell().asSlice();
    return { $$type: 'Context' as const, bounced: _bounced, sender: _sender, value: _value, raw: _raw };
}

function storeTupleContext(source: Context) {
    let builder = new TupleBuilder();
    builder.writeBoolean(source.bounced);
    builder.writeAddress(source.sender);
    builder.writeNumber(source.value);
    builder.writeSlice(source.raw.asCell());
    return builder.build();
}

function dictValueParserContext(): DictionaryValue<Context> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeContext(src)).endCell());
        },
        parse: (src) => {
            return loadContext(src.loadRef().beginParse());
        }
    }
}

export type SendParameters = {
    $$type: 'SendParameters';
    bounce: boolean;
    to: Address;
    value: bigint;
    mode: bigint;
    body: Cell | null;
    code: Cell | null;
    data: Cell | null;
}

export function storeSendParameters(src: SendParameters) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeBit(src.bounce);
        b_0.storeAddress(src.to);
        b_0.storeInt(src.value, 257);
        b_0.storeInt(src.mode, 257);
        if (src.body !== null && src.body !== undefined) { b_0.storeBit(true).storeRef(src.body); } else { b_0.storeBit(false); }
        if (src.code !== null && src.code !== undefined) { b_0.storeBit(true).storeRef(src.code); } else { b_0.storeBit(false); }
        if (src.data !== null && src.data !== undefined) { b_0.storeBit(true).storeRef(src.data); } else { b_0.storeBit(false); }
    };
}

export function loadSendParameters(slice: Slice) {
    let sc_0 = slice;
    let _bounce = sc_0.loadBit();
    let _to = sc_0.loadAddress();
    let _value = sc_0.loadIntBig(257);
    let _mode = sc_0.loadIntBig(257);
    let _body = sc_0.loadBit() ? sc_0.loadRef() : null;
    let _code = sc_0.loadBit() ? sc_0.loadRef() : null;
    let _data = sc_0.loadBit() ? sc_0.loadRef() : null;
    return { $$type: 'SendParameters' as const, bounce: _bounce, to: _to, value: _value, mode: _mode, body: _body, code: _code, data: _data };
}

function loadTupleSendParameters(source: TupleReader) {
    let _bounce = source.readBoolean();
    let _to = source.readAddress();
    let _value = source.readBigNumber();
    let _mode = source.readBigNumber();
    let _body = source.readCellOpt();
    let _code = source.readCellOpt();
    let _data = source.readCellOpt();
    return { $$type: 'SendParameters' as const, bounce: _bounce, to: _to, value: _value, mode: _mode, body: _body, code: _code, data: _data };
}

function loadGetterTupleSendParameters(source: TupleReader) {
    let _bounce = source.readBoolean();
    let _to = source.readAddress();
    let _value = source.readBigNumber();
    let _mode = source.readBigNumber();
    let _body = source.readCellOpt();
    let _code = source.readCellOpt();
    let _data = source.readCellOpt();
    return { $$type: 'SendParameters' as const, bounce: _bounce, to: _to, value: _value, mode: _mode, body: _body, code: _code, data: _data };
}

function storeTupleSendParameters(source: SendParameters) {
    let builder = new TupleBuilder();
    builder.writeBoolean(source.bounce);
    builder.writeAddress(source.to);
    builder.writeNumber(source.value);
    builder.writeNumber(source.mode);
    builder.writeCell(source.body);
    builder.writeCell(source.code);
    builder.writeCell(source.data);
    return builder.build();
}

function dictValueParserSendParameters(): DictionaryValue<SendParameters> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeSendParameters(src)).endCell());
        },
        parse: (src) => {
            return loadSendParameters(src.loadRef().beginParse());
        }
    }
}

export type Deploy = {
    $$type: 'Deploy';
    queryId: bigint;
}

export function storeDeploy(src: Deploy) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(2490013878, 32);
        b_0.storeUint(src.queryId, 64);
    };
}

export function loadDeploy(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 2490013878) { throw Error('Invalid prefix'); }
    let _queryId = sc_0.loadUintBig(64);
    return { $$type: 'Deploy' as const, queryId: _queryId };
}

function loadTupleDeploy(source: TupleReader) {
    let _queryId = source.readBigNumber();
    return { $$type: 'Deploy' as const, queryId: _queryId };
}

function loadGetterTupleDeploy(source: TupleReader) {
    let _queryId = source.readBigNumber();
    return { $$type: 'Deploy' as const, queryId: _queryId };
}

function storeTupleDeploy(source: Deploy) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.queryId);
    return builder.build();
}

function dictValueParserDeploy(): DictionaryValue<Deploy> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeDeploy(src)).endCell());
        },
        parse: (src) => {
            return loadDeploy(src.loadRef().beginParse());
        }
    }
}

export type DeployOk = {
    $$type: 'DeployOk';
    queryId: bigint;
}

export function storeDeployOk(src: DeployOk) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(2952335191, 32);
        b_0.storeUint(src.queryId, 64);
    };
}

export function loadDeployOk(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 2952335191) { throw Error('Invalid prefix'); }
    let _queryId = sc_0.loadUintBig(64);
    return { $$type: 'DeployOk' as const, queryId: _queryId };
}

function loadTupleDeployOk(source: TupleReader) {
    let _queryId = source.readBigNumber();
    return { $$type: 'DeployOk' as const, queryId: _queryId };
}

function loadGetterTupleDeployOk(source: TupleReader) {
    let _queryId = source.readBigNumber();
    return { $$type: 'DeployOk' as const, queryId: _queryId };
}

function storeTupleDeployOk(source: DeployOk) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.queryId);
    return builder.build();
}

function dictValueParserDeployOk(): DictionaryValue<DeployOk> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeDeployOk(src)).endCell());
        },
        parse: (src) => {
            return loadDeployOk(src.loadRef().beginParse());
        }
    }
}

export type FactoryDeploy = {
    $$type: 'FactoryDeploy';
    queryId: bigint;
    cashback: Address;
}

export function storeFactoryDeploy(src: FactoryDeploy) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(1829761339, 32);
        b_0.storeUint(src.queryId, 64);
        b_0.storeAddress(src.cashback);
    };
}

export function loadFactoryDeploy(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 1829761339) { throw Error('Invalid prefix'); }
    let _queryId = sc_0.loadUintBig(64);
    let _cashback = sc_0.loadAddress();
    return { $$type: 'FactoryDeploy' as const, queryId: _queryId, cashback: _cashback };
}

function loadTupleFactoryDeploy(source: TupleReader) {
    let _queryId = source.readBigNumber();
    let _cashback = source.readAddress();
    return { $$type: 'FactoryDeploy' as const, queryId: _queryId, cashback: _cashback };
}

function loadGetterTupleFactoryDeploy(source: TupleReader) {
    let _queryId = source.readBigNumber();
    let _cashback = source.readAddress();
    return { $$type: 'FactoryDeploy' as const, queryId: _queryId, cashback: _cashback };
}

function storeTupleFactoryDeploy(source: FactoryDeploy) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.queryId);
    builder.writeAddress(source.cashback);
    return builder.build();
}

function dictValueParserFactoryDeploy(): DictionaryValue<FactoryDeploy> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeFactoryDeploy(src)).endCell());
        },
        parse: (src) => {
            return loadFactoryDeploy(src.loadRef().beginParse());
        }
    }
}

export type ChangeOwner = {
    $$type: 'ChangeOwner';
    queryId: bigint;
    newOwner: Address;
}

export function storeChangeOwner(src: ChangeOwner) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(2174598809, 32);
        b_0.storeUint(src.queryId, 64);
        b_0.storeAddress(src.newOwner);
    };
}

export function loadChangeOwner(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 2174598809) { throw Error('Invalid prefix'); }
    let _queryId = sc_0.loadUintBig(64);
    let _newOwner = sc_0.loadAddress();
    return { $$type: 'ChangeOwner' as const, queryId: _queryId, newOwner: _newOwner };
}

function loadTupleChangeOwner(source: TupleReader) {
    let _queryId = source.readBigNumber();
    let _newOwner = source.readAddress();
    return { $$type: 'ChangeOwner' as const, queryId: _queryId, newOwner: _newOwner };
}

function loadGetterTupleChangeOwner(source: TupleReader) {
    let _queryId = source.readBigNumber();
    let _newOwner = source.readAddress();
    return { $$type: 'ChangeOwner' as const, queryId: _queryId, newOwner: _newOwner };
}

function storeTupleChangeOwner(source: ChangeOwner) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.queryId);
    builder.writeAddress(source.newOwner);
    return builder.build();
}

function dictValueParserChangeOwner(): DictionaryValue<ChangeOwner> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeChangeOwner(src)).endCell());
        },
        parse: (src) => {
            return loadChangeOwner(src.loadRef().beginParse());
        }
    }
}

export type ChangeOwnerOk = {
    $$type: 'ChangeOwnerOk';
    queryId: bigint;
    newOwner: Address;
}

export function storeChangeOwnerOk(src: ChangeOwnerOk) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(846932810, 32);
        b_0.storeUint(src.queryId, 64);
        b_0.storeAddress(src.newOwner);
    };
}

export function loadChangeOwnerOk(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 846932810) { throw Error('Invalid prefix'); }
    let _queryId = sc_0.loadUintBig(64);
    let _newOwner = sc_0.loadAddress();
    return { $$type: 'ChangeOwnerOk' as const, queryId: _queryId, newOwner: _newOwner };
}

function loadTupleChangeOwnerOk(source: TupleReader) {
    let _queryId = source.readBigNumber();
    let _newOwner = source.readAddress();
    return { $$type: 'ChangeOwnerOk' as const, queryId: _queryId, newOwner: _newOwner };
}

function loadGetterTupleChangeOwnerOk(source: TupleReader) {
    let _queryId = source.readBigNumber();
    let _newOwner = source.readAddress();
    return { $$type: 'ChangeOwnerOk' as const, queryId: _queryId, newOwner: _newOwner };
}

function storeTupleChangeOwnerOk(source: ChangeOwnerOk) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.queryId);
    builder.writeAddress(source.newOwner);
    return builder.build();
}

function dictValueParserChangeOwnerOk(): DictionaryValue<ChangeOwnerOk> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeChangeOwnerOk(src)).endCell());
        },
        parse: (src) => {
            return loadChangeOwnerOk(src.loadRef().beginParse());
        }
    }
}

export type Deposit = {
    $$type: 'Deposit';
    matchId: bigint;
    player1: Address;
    player2: Address;
    stake: bigint;
}

export function storeDeposit(src: Deposit) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(3442647289, 32);
        b_0.storeUint(src.matchId, 256);
        b_0.storeAddress(src.player1);
        b_0.storeAddress(src.player2);
        b_0.storeCoins(src.stake);
    };
}

export function loadDeposit(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 3442647289) { throw Error('Invalid prefix'); }
    let _matchId = sc_0.loadUintBig(256);
    let _player1 = sc_0.loadAddress();
    let _player2 = sc_0.loadAddress();
    let _stake = sc_0.loadCoins();
    return { $$type: 'Deposit' as const, matchId: _matchId, player1: _player1, player2: _player2, stake: _stake };
}

function loadTupleDeposit(source: TupleReader) {
    let _matchId = source.readBigNumber();
    let _player1 = source.readAddress();
    let _player2 = source.readAddress();
    let _stake = source.readBigNumber();
    return { $$type: 'Deposit' as const, matchId: _matchId, player1: _player1, player2: _player2, stake: _stake };
}

function loadGetterTupleDeposit(source: TupleReader) {
    let _matchId = source.readBigNumber();
    let _player1 = source.readAddress();
    let _player2 = source.readAddress();
    let _stake = source.readBigNumber();
    return { $$type: 'Deposit' as const, matchId: _matchId, player1: _player1, player2: _player2, stake: _stake };
}

function storeTupleDeposit(source: Deposit) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.matchId);
    builder.writeAddress(source.player1);
    builder.writeAddress(source.player2);
    builder.writeNumber(source.stake);
    return builder.build();
}

function dictValueParserDeposit(): DictionaryValue<Deposit> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeDeposit(src)).endCell());
        },
        parse: (src) => {
            return loadDeposit(src.loadRef().beginParse());
        }
    }
}

export type Settle = {
    $$type: 'Settle';
    matchId: bigint;
    winner: Address;
    reason: bigint;
    signature: Slice;
}

export function storeSettle(src: Settle) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(3720944991, 32);
        b_0.storeUint(src.matchId, 256);
        b_0.storeAddress(src.winner);
        b_0.storeUint(src.reason, 8);
        b_0.storeRef(src.signature.asCell());
    };
}

export function loadSettle(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 3720944991) { throw Error('Invalid prefix'); }
    let _matchId = sc_0.loadUintBig(256);
    let _winner = sc_0.loadAddress();
    let _reason = sc_0.loadUintBig(8);
    let _signature = sc_0.loadRef().asSlice();
    return { $$type: 'Settle' as const, matchId: _matchId, winner: _winner, reason: _reason, signature: _signature };
}

function loadTupleSettle(source: TupleReader) {
    let _matchId = source.readBigNumber();
    let _winner = source.readAddress();
    let _reason = source.readBigNumber();
    let _signature = source.readCell().asSlice();
    return { $$type: 'Settle' as const, matchId: _matchId, winner: _winner, reason: _reason, signature: _signature };
}

function loadGetterTupleSettle(source: TupleReader) {
    let _matchId = source.readBigNumber();
    let _winner = source.readAddress();
    let _reason = source.readBigNumber();
    let _signature = source.readCell().asSlice();
    return { $$type: 'Settle' as const, matchId: _matchId, winner: _winner, reason: _reason, signature: _signature };
}

function storeTupleSettle(source: Settle) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.matchId);
    builder.writeAddress(source.winner);
    builder.writeNumber(source.reason);
    builder.writeSlice(source.signature.asCell());
    return builder.build();
}

function dictValueParserSettle(): DictionaryValue<Settle> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeSettle(src)).endCell());
        },
        parse: (src) => {
            return loadSettle(src.loadRef().beginParse());
        }
    }
}

export type RefundNoShow = {
    $$type: 'RefundNoShow';
    matchId: bigint;
}

export function storeRefundNoShow(src: RefundNoShow) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(1490927691, 32);
        b_0.storeUint(src.matchId, 256);
    };
}

export function loadRefundNoShow(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 1490927691) { throw Error('Invalid prefix'); }
    let _matchId = sc_0.loadUintBig(256);
    return { $$type: 'RefundNoShow' as const, matchId: _matchId };
}

function loadTupleRefundNoShow(source: TupleReader) {
    let _matchId = source.readBigNumber();
    return { $$type: 'RefundNoShow' as const, matchId: _matchId };
}

function loadGetterTupleRefundNoShow(source: TupleReader) {
    let _matchId = source.readBigNumber();
    return { $$type: 'RefundNoShow' as const, matchId: _matchId };
}

function storeTupleRefundNoShow(source: RefundNoShow) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.matchId);
    return builder.build();
}

function dictValueParserRefundNoShow(): DictionaryValue<RefundNoShow> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeRefundNoShow(src)).endCell());
        },
        parse: (src) => {
            return loadRefundNoShow(src.loadRef().beginParse());
        }
    }
}

export type SetOraclePubkey = {
    $$type: 'SetOraclePubkey';
    newPubkey: bigint;
}

export function storeSetOraclePubkey(src: SetOraclePubkey) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(1555336977, 32);
        b_0.storeUint(src.newPubkey, 256);
    };
}

export function loadSetOraclePubkey(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 1555336977) { throw Error('Invalid prefix'); }
    let _newPubkey = sc_0.loadUintBig(256);
    return { $$type: 'SetOraclePubkey' as const, newPubkey: _newPubkey };
}

function loadTupleSetOraclePubkey(source: TupleReader) {
    let _newPubkey = source.readBigNumber();
    return { $$type: 'SetOraclePubkey' as const, newPubkey: _newPubkey };
}

function loadGetterTupleSetOraclePubkey(source: TupleReader) {
    let _newPubkey = source.readBigNumber();
    return { $$type: 'SetOraclePubkey' as const, newPubkey: _newPubkey };
}

function storeTupleSetOraclePubkey(source: SetOraclePubkey) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.newPubkey);
    return builder.build();
}

function dictValueParserSetOraclePubkey(): DictionaryValue<SetOraclePubkey> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeSetOraclePubkey(src)).endCell());
        },
        parse: (src) => {
            return loadSetOraclePubkey(src.loadRef().beginParse());
        }
    }
}

export type SetPlatformWallet = {
    $$type: 'SetPlatformWallet';
    newWallet: Address;
}

export function storeSetPlatformWallet(src: SetPlatformWallet) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(3203666596, 32);
        b_0.storeAddress(src.newWallet);
    };
}

export function loadSetPlatformWallet(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 3203666596) { throw Error('Invalid prefix'); }
    let _newWallet = sc_0.loadAddress();
    return { $$type: 'SetPlatformWallet' as const, newWallet: _newWallet };
}

function loadTupleSetPlatformWallet(source: TupleReader) {
    let _newWallet = source.readAddress();
    return { $$type: 'SetPlatformWallet' as const, newWallet: _newWallet };
}

function loadGetterTupleSetPlatformWallet(source: TupleReader) {
    let _newWallet = source.readAddress();
    return { $$type: 'SetPlatformWallet' as const, newWallet: _newWallet };
}

function storeTupleSetPlatformWallet(source: SetPlatformWallet) {
    let builder = new TupleBuilder();
    builder.writeAddress(source.newWallet);
    return builder.build();
}

function dictValueParserSetPlatformWallet(): DictionaryValue<SetPlatformWallet> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeSetPlatformWallet(src)).endCell());
        },
        parse: (src) => {
            return loadSetPlatformWallet(src.loadRef().beginParse());
        }
    }
}

export type SetDepositTimeout = {
    $$type: 'SetDepositTimeout';
    seconds: bigint;
}

export function storeSetDepositTimeout(src: SetDepositTimeout) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(4061189531, 32);
        b_0.storeUint(src.seconds, 32);
    };
}

export function loadSetDepositTimeout(slice: Slice) {
    let sc_0 = slice;
    if (sc_0.loadUint(32) !== 4061189531) { throw Error('Invalid prefix'); }
    let _seconds = sc_0.loadUintBig(32);
    return { $$type: 'SetDepositTimeout' as const, seconds: _seconds };
}

function loadTupleSetDepositTimeout(source: TupleReader) {
    let _seconds = source.readBigNumber();
    return { $$type: 'SetDepositTimeout' as const, seconds: _seconds };
}

function loadGetterTupleSetDepositTimeout(source: TupleReader) {
    let _seconds = source.readBigNumber();
    return { $$type: 'SetDepositTimeout' as const, seconds: _seconds };
}

function storeTupleSetDepositTimeout(source: SetDepositTimeout) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.seconds);
    return builder.build();
}

function dictValueParserSetDepositTimeout(): DictionaryValue<SetDepositTimeout> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeSetDepositTimeout(src)).endCell());
        },
        parse: (src) => {
            return loadSetDepositTimeout(src.loadRef().beginParse());
        }
    }
}

export type Match = {
    $$type: 'Match';
    matchId: bigint;
    player1: Address;
    player2: Address;
    stake: bigint;
    p1Funded: boolean;
    p2Funded: boolean;
    firstDepositAt: bigint;
    status: bigint;
}

export function storeMatch(src: Match) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeUint(src.matchId, 256);
        b_0.storeAddress(src.player1);
        b_0.storeAddress(src.player2);
        b_0.storeCoins(src.stake);
        b_0.storeBit(src.p1Funded);
        b_0.storeBit(src.p2Funded);
        b_0.storeUint(src.firstDepositAt, 32);
        b_0.storeUint(src.status, 8);
    };
}

export function loadMatch(slice: Slice) {
    let sc_0 = slice;
    let _matchId = sc_0.loadUintBig(256);
    let _player1 = sc_0.loadAddress();
    let _player2 = sc_0.loadAddress();
    let _stake = sc_0.loadCoins();
    let _p1Funded = sc_0.loadBit();
    let _p2Funded = sc_0.loadBit();
    let _firstDepositAt = sc_0.loadUintBig(32);
    let _status = sc_0.loadUintBig(8);
    return { $$type: 'Match' as const, matchId: _matchId, player1: _player1, player2: _player2, stake: _stake, p1Funded: _p1Funded, p2Funded: _p2Funded, firstDepositAt: _firstDepositAt, status: _status };
}

function loadTupleMatch(source: TupleReader) {
    let _matchId = source.readBigNumber();
    let _player1 = source.readAddress();
    let _player2 = source.readAddress();
    let _stake = source.readBigNumber();
    let _p1Funded = source.readBoolean();
    let _p2Funded = source.readBoolean();
    let _firstDepositAt = source.readBigNumber();
    let _status = source.readBigNumber();
    return { $$type: 'Match' as const, matchId: _matchId, player1: _player1, player2: _player2, stake: _stake, p1Funded: _p1Funded, p2Funded: _p2Funded, firstDepositAt: _firstDepositAt, status: _status };
}

function loadGetterTupleMatch(source: TupleReader) {
    let _matchId = source.readBigNumber();
    let _player1 = source.readAddress();
    let _player2 = source.readAddress();
    let _stake = source.readBigNumber();
    let _p1Funded = source.readBoolean();
    let _p2Funded = source.readBoolean();
    let _firstDepositAt = source.readBigNumber();
    let _status = source.readBigNumber();
    return { $$type: 'Match' as const, matchId: _matchId, player1: _player1, player2: _player2, stake: _stake, p1Funded: _p1Funded, p2Funded: _p2Funded, firstDepositAt: _firstDepositAt, status: _status };
}

function storeTupleMatch(source: Match) {
    let builder = new TupleBuilder();
    builder.writeNumber(source.matchId);
    builder.writeAddress(source.player1);
    builder.writeAddress(source.player2);
    builder.writeNumber(source.stake);
    builder.writeBoolean(source.p1Funded);
    builder.writeBoolean(source.p2Funded);
    builder.writeNumber(source.firstDepositAt);
    builder.writeNumber(source.status);
    return builder.build();
}

function dictValueParserMatch(): DictionaryValue<Match> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeMatch(src)).endCell());
        },
        parse: (src) => {
            return loadMatch(src.loadRef().beginParse());
        }
    }
}

export type Skills2CryptoEscrowTON$Data = {
    $$type: 'Skills2CryptoEscrowTON$Data';
    owner: Address;
    oraclePubkey: bigint;
    platformWallet: Address;
    depositTimeoutSeconds: bigint;
    matches: Dictionary<bigint, Match>;
}

export function storeSkills2CryptoEscrowTON$Data(src: Skills2CryptoEscrowTON$Data) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeAddress(src.owner);
        b_0.storeUint(src.oraclePubkey, 256);
        b_0.storeAddress(src.platformWallet);
        b_0.storeUint(src.depositTimeoutSeconds, 32);
        b_0.storeDict(src.matches, Dictionary.Keys.BigInt(257), dictValueParserMatch());
    };
}

export function loadSkills2CryptoEscrowTON$Data(slice: Slice) {
    let sc_0 = slice;
    let _owner = sc_0.loadAddress();
    let _oraclePubkey = sc_0.loadUintBig(256);
    let _platformWallet = sc_0.loadAddress();
    let _depositTimeoutSeconds = sc_0.loadUintBig(32);
    let _matches = Dictionary.load(Dictionary.Keys.BigInt(257), dictValueParserMatch(), sc_0);
    return { $$type: 'Skills2CryptoEscrowTON$Data' as const, owner: _owner, oraclePubkey: _oraclePubkey, platformWallet: _platformWallet, depositTimeoutSeconds: _depositTimeoutSeconds, matches: _matches };
}

function loadTupleSkills2CryptoEscrowTON$Data(source: TupleReader) {
    let _owner = source.readAddress();
    let _oraclePubkey = source.readBigNumber();
    let _platformWallet = source.readAddress();
    let _depositTimeoutSeconds = source.readBigNumber();
    let _matches = Dictionary.loadDirect(Dictionary.Keys.BigInt(257), dictValueParserMatch(), source.readCellOpt());
    return { $$type: 'Skills2CryptoEscrowTON$Data' as const, owner: _owner, oraclePubkey: _oraclePubkey, platformWallet: _platformWallet, depositTimeoutSeconds: _depositTimeoutSeconds, matches: _matches };
}

function loadGetterTupleSkills2CryptoEscrowTON$Data(source: TupleReader) {
    let _owner = source.readAddress();
    let _oraclePubkey = source.readBigNumber();
    let _platformWallet = source.readAddress();
    let _depositTimeoutSeconds = source.readBigNumber();
    let _matches = Dictionary.loadDirect(Dictionary.Keys.BigInt(257), dictValueParserMatch(), source.readCellOpt());
    return { $$type: 'Skills2CryptoEscrowTON$Data' as const, owner: _owner, oraclePubkey: _oraclePubkey, platformWallet: _platformWallet, depositTimeoutSeconds: _depositTimeoutSeconds, matches: _matches };
}

function storeTupleSkills2CryptoEscrowTON$Data(source: Skills2CryptoEscrowTON$Data) {
    let builder = new TupleBuilder();
    builder.writeAddress(source.owner);
    builder.writeNumber(source.oraclePubkey);
    builder.writeAddress(source.platformWallet);
    builder.writeNumber(source.depositTimeoutSeconds);
    builder.writeCell(source.matches.size > 0 ? beginCell().storeDictDirect(source.matches, Dictionary.Keys.BigInt(257), dictValueParserMatch()).endCell() : null);
    return builder.build();
}

function dictValueParserSkills2CryptoEscrowTON$Data(): DictionaryValue<Skills2CryptoEscrowTON$Data> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeSkills2CryptoEscrowTON$Data(src)).endCell());
        },
        parse: (src) => {
            return loadSkills2CryptoEscrowTON$Data(src.loadRef().beginParse());
        }
    }
}

 type Skills2CryptoEscrowTON_init_args = {
    $$type: 'Skills2CryptoEscrowTON_init_args';
    oraclePubkey: bigint;
    platformWallet: Address;
    depositTimeoutSeconds: bigint;
}

function initSkills2CryptoEscrowTON_init_args(src: Skills2CryptoEscrowTON_init_args) {
    return (builder: Builder) => {
        let b_0 = builder;
        b_0.storeInt(src.oraclePubkey, 257);
        b_0.storeAddress(src.platformWallet);
        b_0.storeInt(src.depositTimeoutSeconds, 257);
    };
}

async function Skills2CryptoEscrowTON_init(oraclePubkey: bigint, platformWallet: Address, depositTimeoutSeconds: bigint) {
    const __code = Cell.fromBase64('te6ccgECNAEACP4AART/APSkE/S88sgLAQIBYgIDA3rQAdDTAwFxsKMB+kABINdJgQELuvLgiCDXCwoggQT/uvLQiYMJuvLgiFRQUwNvBPhhAvhi2zxVFNs88uCCFAQFAgEgBgcC9gGSMH/gcCHXScIflTAg1wsf3iCCEM0yoPm6jtYw0x8BghDNMqD5uvLggdP/+kABINdJgQELuvLgiCDXCwoggQT/uvLQiYMJuvLgiAH6QAEg10mBAQu68uCIINcLCiCBBP+68tCJgwm68uCIAfoAVTBsFOAgghDdyR1fuhgZAKrI+EMBzH8BygBVQFBUINdJgQELuvLgiCDXCwoggQT/uvLQiYMJuvLgiM8WEsv/ASDXSYEBC7ry4Igg1wsKIIEE/7ry0ImDCbry4IjPFhLLH/QAye1UAgEgCAkAEb4V92omhpAADAIRuqM9s82zxsUYFAoCASALDAACIQIRtKO7Z5tnjYowFA0CASAODwACJAIBIBARAhGzx3bPNs8bFGAUFQIRrcxtnm2eNijAFBICQa2l7Z4qgm2eNiiQN0kYNsyQN3loQDeUN4RxEDdJGDbvQBQTAAIjATqBAQEiAln0DW+hkjBt3yBukjBtjofQ2zxsGG8I4ioBxO1E0NQB+GPSAAGOSvpAASDXSYEBC7ry4Igg1wsKIIEE/7ry0ImDCbry4IgB0//6QAEg10mBAQu68uCIINcLCiCBBP+68tCJgwm68uCIAdMf9ARVQGwV4Pgo1wsKgwm68uCJFgACIgFigQEB1wD6QAEg10mBAQu68uCIINcLCiCBBP+68tCJgwm68uCIAYEBAdcAVSAD0VjbPBcACvhCVSBtA774QoIA7hBTNMcFs/L0ggDSjCLCAPL0ggCo41NBxwWRf5RTMccF4vL0ggCKT/hBbyQTXwMjggr68ICgvvL0JYEBASZZ9A1voZIwbd8gbpIwbY6H0Ns8bBhvCOIgbuMPfyoaGwTwjr0w0x8BghDdyR1fuvLggdP/+kABINdJgQELuvLgiCDXCwoggQT/uvLQiYMJuvLgiAHTB9QB0BRDMGwU2zx/4CCCEFjdwEu64wIgghBctI8Ruo6bMNMfAYIQXLSPEbry4IHT/wExVUDbPDMQNFh/4CCCEL70EqS6HB0vHgFYMIEBAVNBxwVSQ8cF+CMnBhBXBBA3WXHIVXDbPMkSIG6VMFn0WjCUQTP0FeItAeQgbvLQgG8ogTUaIcAB8vSBDBhRx8cFlFGlxwWSOnDiG/L0IoErdwm6GPL0UjbHBZqCAKK8BbMV8vR/nIIA03QGsxby9H8FBOIgkSWRcOKScjfeEDZAVQQDB4EBAQjIVXDbPMkSIG6VMFn0WjCUQTP0FeItAvSCAJI3IsL/kyLBA5Fw4vL0JIEBASVZ9A1voZIwbd8gbpIwbY6H0Ns8bBhvCOKCAOvgIW6z8vQgbvLQgG8oggDwWgHAAvL0yFKwy/8qINdJgQELuvLgiCDXCwoggQT/uvLQiYMJuvLgiM8WUpDLB8mCALafAfkAUAlWECofA7ww0x8BghBY3cBLuvLggdP/ATEhgQEBIln0DW+hkjBt3yBukjBtjofQ2zxsGG8I4oIA6+AhbrPy9CBu8tCAbyiBG/IBwAHy9IEQJvgjUyugvPL0+EIjkiKzkXDi4w9/KissA9qOuDDTHwGCEL70EqS68uCB+kABINdJgQELuvLgiCDXCwoggQT/uvLQiYMJuvLgiDFVQNs8MhA0QwB/4CCCEPIQ1Zu6jpww0x8BghDyENWbuvLggdMfATFVQNs8MRA0QTB/4IIQlGqYtrrjAjBwLy8wA9j5EBjy9PhCKMAAjhyCALWkU2rHBZF/lFNaxwXi8vQpggCqLALHBfL0jhOCAI9uU2HHBZIxf5RSUscF4vL04hAlc4EBASZRRlFJQTQbyFVw2zzJEDhEcCBulTBZ9FowlEEz9BXiJaoAI8AA4w8tICEETDU1WyGBASyogScQqQRRIqFxcIgUQzBtbds8MHFwiCZVMBRDMG1tIjInKQIMNALAAeMPIyQAHAAAAABXaW4gcGF5b3V0BFYCgQEsqIEnEKkEIKsAFaFxcIgjEEZVIBRDMG1t2zwwcXCIEEUQNRRDMG1tJTIlJgQ2MnFwiCYQRVUgFEMwbW3bPDBxcIgQNRRDMG1tKDIoKQAeAAAAAERyYXcgcmVmdW5kAybbPDBxcIgmBAVVIBRDMG1t2zwwMicyACAAAAAAUGxhdGZvcm0gZmVlACoAAAAARGlzY29ubmVjdCByZWZ1bmQBBts8MDIAnNP/+kABINdJgQELuvLgiCDXCwoggQT/uvLQiYMJuvLgiAH6QAEg10mBAQu68uCIINcLCiCBBP+68tCJgwm68uCIAfoA0gDSANMf0wdVcAN0UmDHBfLlsxA2c4EBASdRWRBYSDQByFVw2zzJEDVBQCBulTBZ9FowlEEz9BXicXCIEDUUQzBtbds8MC0uMgOYIpIjs5Fw4o+5UlDHBfLlsxA2ECVzJVE4SBOBAQEJyFVw2zzJEDUUIG6VMFn0WjCUQTP0FeJxcIgQNRRDMG1t2zwwmF8JggDiffLw4i0uMgCeUHjL/1AFINdJgQELuvLgiCDXCwoggQT/uvLQiYMJuvLgiM8WUAMg10mBAQu68uCIINcLCiCBBP+68tCJgwm68uCIzxYB+gLKAMoAyx/LBwAkAAAAAE5vLXNob3cgcmVmdW5kABL4QlJQxwXy4IQBTtMfAYIQlGqYtrry4IHTPwExyAGCEK/5D1dYyx/LP8n4QgFwbds8fzEBPG1tIm6zmVsgbvLQgG8iAZEy4hAkcAMEgEJQI9s8MDIByshxAcoBUAcBygBwAcoCUAUg10mBAQu68uCIINcLCiCBBP+68tCJgwm68uCIzxZQA/oCcAHKaCNus5F/kyRus+KXMzMBcAHKAOMNIW6znH8BygABIG7y0IABzJUxcAHKAOLJAfsIMwCYfwHKAMhwAcoAcAHKACRus51/AcoABCBu8tCAUATMljQDcAHKAOIkbrOdfwHKAAQgbvLQgFAEzJY0A3ABygDicAHKAAJ/AcoAAslYzA==');
    const __system = Cell.fromBase64('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');
    let builder = beginCell();
    builder.storeRef(__system);
    builder.storeUint(0, 1);
    initSkills2CryptoEscrowTON_init_args({ $$type: 'Skills2CryptoEscrowTON_init_args', oraclePubkey, platformWallet, depositTimeoutSeconds })(builder);
    const __data = builder.endCell();
    return { code: __code, data: __data };
}

const Skills2CryptoEscrowTON_errors: { [key: number]: { message: string } } = {
    2: { message: `Stack underflow` },
    3: { message: `Stack overflow` },
    4: { message: `Integer overflow` },
    5: { message: `Integer out of expected range` },
    6: { message: `Invalid opcode` },
    7: { message: `Type check error` },
    8: { message: `Cell overflow` },
    9: { message: `Cell underflow` },
    10: { message: `Dictionary error` },
    11: { message: `'Unknown' error` },
    12: { message: `Fatal error` },
    13: { message: `Out of gas error` },
    14: { message: `Virtualization error` },
    32: { message: `Action list is invalid` },
    33: { message: `Action list is too long` },
    34: { message: `Action is invalid or not supported` },
    35: { message: `Invalid source address in outbound message` },
    36: { message: `Invalid destination address in outbound message` },
    37: { message: `Not enough TON` },
    38: { message: `Not enough extra-currencies` },
    39: { message: `Outbound message does not fit into a cell after rewriting` },
    40: { message: `Cannot process a message` },
    41: { message: `Library reference is null` },
    42: { message: `Library change action error` },
    43: { message: `Exceeded maximum number of cells in the library or the maximum depth of the Merkle tree` },
    50: { message: `Account state size exceeded limits` },
    128: { message: `Null reference exception` },
    129: { message: `Invalid serialization prefix` },
    130: { message: `Invalid incoming message` },
    131: { message: `Constraints error` },
    132: { message: `Access denied` },
    133: { message: `Contract stopped` },
    134: { message: `Invalid argument` },
    135: { message: `Code of a contract was not found` },
    136: { message: `Invalid address` },
    137: { message: `Masterchain support is not enabled for this contract` },
    1459: { message: `Only depositor` },
    3096: { message: `Player mismatch` },
    4134: { message: `Not expired` },
    7154: { message: `Not pending` },
    11127: { message: `Stake mismatch` },
    13594: { message: `Match not pending` },
    35407: { message: `Insufficient TON` },
    36718: { message: `Only player` },
    37431: { message: `Invalid reason` },
    41660: { message: `P1 already funded` },
    43235: { message: `Not a player` },
    43564: { message: `Only winner can claim` },
    46500: { message: `Invalid winner` },
    46751: { message: `Invalid oracle sig` },
    53900: { message: `Zero stake` },
    54132: { message: `P2 already funded` },
    57981: { message: `Invalid funding state` },
    60384: { message: `Match not found` },
    60944: { message: `Same player` },
    61530: { message: `Not active` },
}

const Skills2CryptoEscrowTON_types: ABIType[] = [
    {"name":"StateInit","header":null,"fields":[{"name":"code","type":{"kind":"simple","type":"cell","optional":false}},{"name":"data","type":{"kind":"simple","type":"cell","optional":false}}]},
    {"name":"StdAddress","header":null,"fields":[{"name":"workchain","type":{"kind":"simple","type":"int","optional":false,"format":8}},{"name":"address","type":{"kind":"simple","type":"uint","optional":false,"format":256}}]},
    {"name":"VarAddress","header":null,"fields":[{"name":"workchain","type":{"kind":"simple","type":"int","optional":false,"format":32}},{"name":"address","type":{"kind":"simple","type":"slice","optional":false}}]},
    {"name":"Context","header":null,"fields":[{"name":"bounced","type":{"kind":"simple","type":"bool","optional":false}},{"name":"sender","type":{"kind":"simple","type":"address","optional":false}},{"name":"value","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"raw","type":{"kind":"simple","type":"slice","optional":false}}]},
    {"name":"SendParameters","header":null,"fields":[{"name":"bounce","type":{"kind":"simple","type":"bool","optional":false}},{"name":"to","type":{"kind":"simple","type":"address","optional":false}},{"name":"value","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"mode","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"body","type":{"kind":"simple","type":"cell","optional":true}},{"name":"code","type":{"kind":"simple","type":"cell","optional":true}},{"name":"data","type":{"kind":"simple","type":"cell","optional":true}}]},
    {"name":"Deploy","header":2490013878,"fields":[{"name":"queryId","type":{"kind":"simple","type":"uint","optional":false,"format":64}}]},
    {"name":"DeployOk","header":2952335191,"fields":[{"name":"queryId","type":{"kind":"simple","type":"uint","optional":false,"format":64}}]},
    {"name":"FactoryDeploy","header":1829761339,"fields":[{"name":"queryId","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"cashback","type":{"kind":"simple","type":"address","optional":false}}]},
    {"name":"ChangeOwner","header":2174598809,"fields":[{"name":"queryId","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"newOwner","type":{"kind":"simple","type":"address","optional":false}}]},
    {"name":"ChangeOwnerOk","header":846932810,"fields":[{"name":"queryId","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"newOwner","type":{"kind":"simple","type":"address","optional":false}}]},
    {"name":"Deposit","header":3442647289,"fields":[{"name":"matchId","type":{"kind":"simple","type":"uint","optional":false,"format":256}},{"name":"player1","type":{"kind":"simple","type":"address","optional":false}},{"name":"player2","type":{"kind":"simple","type":"address","optional":false}},{"name":"stake","type":{"kind":"simple","type":"uint","optional":false,"format":"coins"}}]},
    {"name":"Settle","header":3720944991,"fields":[{"name":"matchId","type":{"kind":"simple","type":"uint","optional":false,"format":256}},{"name":"winner","type":{"kind":"simple","type":"address","optional":false}},{"name":"reason","type":{"kind":"simple","type":"uint","optional":false,"format":8}},{"name":"signature","type":{"kind":"simple","type":"slice","optional":false}}]},
    {"name":"RefundNoShow","header":1490927691,"fields":[{"name":"matchId","type":{"kind":"simple","type":"uint","optional":false,"format":256}}]},
    {"name":"SetOraclePubkey","header":1555336977,"fields":[{"name":"newPubkey","type":{"kind":"simple","type":"uint","optional":false,"format":256}}]},
    {"name":"SetPlatformWallet","header":3203666596,"fields":[{"name":"newWallet","type":{"kind":"simple","type":"address","optional":false}}]},
    {"name":"SetDepositTimeout","header":4061189531,"fields":[{"name":"seconds","type":{"kind":"simple","type":"uint","optional":false,"format":32}}]},
    {"name":"Match","header":null,"fields":[{"name":"matchId","type":{"kind":"simple","type":"uint","optional":false,"format":256}},{"name":"player1","type":{"kind":"simple","type":"address","optional":false}},{"name":"player2","type":{"kind":"simple","type":"address","optional":false}},{"name":"stake","type":{"kind":"simple","type":"uint","optional":false,"format":"coins"}},{"name":"p1Funded","type":{"kind":"simple","type":"bool","optional":false}},{"name":"p2Funded","type":{"kind":"simple","type":"bool","optional":false}},{"name":"firstDepositAt","type":{"kind":"simple","type":"uint","optional":false,"format":32}},{"name":"status","type":{"kind":"simple","type":"uint","optional":false,"format":8}}]},
    {"name":"Skills2CryptoEscrowTON$Data","header":null,"fields":[{"name":"owner","type":{"kind":"simple","type":"address","optional":false}},{"name":"oraclePubkey","type":{"kind":"simple","type":"uint","optional":false,"format":256}},{"name":"platformWallet","type":{"kind":"simple","type":"address","optional":false}},{"name":"depositTimeoutSeconds","type":{"kind":"simple","type":"uint","optional":false,"format":32}},{"name":"matches","type":{"kind":"dict","key":"int","value":"Match","valueFormat":"ref"}}]},
]

const Skills2CryptoEscrowTON_getters: ABIGetter[] = [
    {"name":"getMatch","arguments":[{"name":"matchId","type":{"kind":"simple","type":"int","optional":false,"format":257}}],"returnType":{"kind":"simple","type":"Match","optional":true}},
    {"name":"getOraclePubkey","arguments":[],"returnType":{"kind":"simple","type":"int","optional":false,"format":257}},
    {"name":"getPlatformWallet","arguments":[],"returnType":{"kind":"simple","type":"address","optional":false}},
    {"name":"getDepositTimeoutSeconds","arguments":[],"returnType":{"kind":"simple","type":"int","optional":false,"format":257}},
    {"name":"owner","arguments":[],"returnType":{"kind":"simple","type":"address","optional":false}},
]

export const Skills2CryptoEscrowTON_getterMapping: { [key: string]: string } = {
    'getMatch': 'getGetMatch',
    'getOraclePubkey': 'getGetOraclePubkey',
    'getPlatformWallet': 'getGetPlatformWallet',
    'getDepositTimeoutSeconds': 'getGetDepositTimeoutSeconds',
    'owner': 'getOwner',
}

const Skills2CryptoEscrowTON_receivers: ABIReceiver[] = [
    {"receiver":"internal","message":{"kind":"typed","type":"Deposit"}},
    {"receiver":"internal","message":{"kind":"typed","type":"Settle"}},
    {"receiver":"internal","message":{"kind":"typed","type":"RefundNoShow"}},
    {"receiver":"internal","message":{"kind":"typed","type":"SetOraclePubkey"}},
    {"receiver":"internal","message":{"kind":"typed","type":"SetPlatformWallet"}},
    {"receiver":"internal","message":{"kind":"typed","type":"SetDepositTimeout"}},
    {"receiver":"internal","message":{"kind":"typed","type":"Deploy"}},
]

export class Skills2CryptoEscrowTON implements Contract {
    
    static async init(oraclePubkey: bigint, platformWallet: Address, depositTimeoutSeconds: bigint) {
        return await Skills2CryptoEscrowTON_init(oraclePubkey, platformWallet, depositTimeoutSeconds);
    }
    
    static async fromInit(oraclePubkey: bigint, platformWallet: Address, depositTimeoutSeconds: bigint) {
        const init = await Skills2CryptoEscrowTON_init(oraclePubkey, platformWallet, depositTimeoutSeconds);
        const address = contractAddress(0, init);
        return new Skills2CryptoEscrowTON(address, init);
    }
    
    static fromAddress(address: Address) {
        return new Skills2CryptoEscrowTON(address);
    }
    
    readonly address: Address; 
    readonly init?: { code: Cell, data: Cell };
    readonly abi: ContractABI = {
        types:  Skills2CryptoEscrowTON_types,
        getters: Skills2CryptoEscrowTON_getters,
        receivers: Skills2CryptoEscrowTON_receivers,
        errors: Skills2CryptoEscrowTON_errors,
    };
    
    private constructor(address: Address, init?: { code: Cell, data: Cell }) {
        this.address = address;
        this.init = init;
    }
    
    async send(provider: ContractProvider, via: Sender, args: { value: bigint, bounce?: boolean| null | undefined }, message: Deposit | Settle | RefundNoShow | SetOraclePubkey | SetPlatformWallet | SetDepositTimeout | Deploy) {
        
        let body: Cell | null = null;
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'Deposit') {
            body = beginCell().store(storeDeposit(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'Settle') {
            body = beginCell().store(storeSettle(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'RefundNoShow') {
            body = beginCell().store(storeRefundNoShow(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'SetOraclePubkey') {
            body = beginCell().store(storeSetOraclePubkey(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'SetPlatformWallet') {
            body = beginCell().store(storeSetPlatformWallet(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'SetDepositTimeout') {
            body = beginCell().store(storeSetDepositTimeout(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'Deploy') {
            body = beginCell().store(storeDeploy(message)).endCell();
        }
        if (body === null) { throw new Error('Invalid message type'); }
        
        await provider.internal(via, { ...args, body: body });
        
    }
    
    async getGetMatch(provider: ContractProvider, matchId: bigint) {
        let builder = new TupleBuilder();
        builder.writeNumber(matchId);
        let source = (await provider.get('getMatch', builder.build())).stack;
        const result_p = source.readTupleOpt();
        const result = result_p ? loadTupleMatch(result_p) : null;
        return result;
    }
    
    async getGetOraclePubkey(provider: ContractProvider) {
        let builder = new TupleBuilder();
        let source = (await provider.get('getOraclePubkey', builder.build())).stack;
        let result = source.readBigNumber();
        return result;
    }
    
    async getGetPlatformWallet(provider: ContractProvider) {
        let builder = new TupleBuilder();
        let source = (await provider.get('getPlatformWallet', builder.build())).stack;
        let result = source.readAddress();
        return result;
    }
    
    async getGetDepositTimeoutSeconds(provider: ContractProvider) {
        let builder = new TupleBuilder();
        let source = (await provider.get('getDepositTimeoutSeconds', builder.build())).stack;
        let result = source.readBigNumber();
        return result;
    }
    
    async getOwner(provider: ContractProvider) {
        let builder = new TupleBuilder();
        let source = (await provider.get('owner', builder.build())).stack;
        let result = source.readAddress();
        return result;
    }
    
}
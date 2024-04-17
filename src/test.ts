require('dotenv').config()
import { AddressPrefix, addressToScript, getTransactionSize, privateKeyToAddress } from '@nervosnetwork/ckb-sdk-utils';
import { getSecp256k1CellDep, Collector, NoLiveCellError, calculateUdtCellCapacity, MAX_FEE, MIN_CAPACITY, append0x, u128ToLe, getXudtDep, getUniqueTypeDep, SECP256K1_WITNESS_LOCK_SIZE, calculateTransactionFee, NoXudtLiveCellError } from '@rgbpp-sdk/ckb';
import { XUDT_TOKEN_INFO } from './0-token-info';

// CKB SECP256K1 private key
const CKB_TEST_PRIVATE_KEY = process.env.PRIVATE_KEY;
const P2 = process.env.HOT_PRIVATE_KEY;
if (!P2) {
  console.log("Please config P2 in env")
  process.exit()
}
const isMainnet = false;
const toAddress = privateKeyToAddress(P2, {
  prefix: isMainnet ? AddressPrefix.Mainnet : AddressPrefix.Testnet,
});
console.log('to address: ', toAddress); // ckt1qyqz4yjxekglwevzkn5htz525gs5z2ggsvfs2m9r0t
interface TransferParams {
  xudtType: CKBComponents.Script,
  receivers: {
    toAddress: string;
    transferAmount: bigint;
  }[];
}

/**
 * transferXudt can be used to mint xUDT assets or transfer xUDT assets.
 * @param: xudtType The xUDT type script that comes from 1-issue-xudt
 * @param: receivers The receiver includes toAddress and transferAmount
 */
const transferXudt = async ({ xudtType, receivers }: TransferParams) => {
  const collector = new Collector({
    ckbNodeUrl: 'https://testnet.ckb.dev/rpc',
    ckbIndexerUrl: 'https://testnet.ckb.dev/indexer',
  });
  const isMainnet = false;
  const fromAddress = privateKeyToAddress(CKB_TEST_PRIVATE_KEY, {
    prefix: isMainnet ? AddressPrefix.Mainnet : AddressPrefix.Testnet,
  });
  console.log('ckb address: ', fromAddress);

  const fromLock = addressToScript(fromAddress);

  const xudtCells = await collector.getCells({
    lock: fromLock,
    type: xudtType,
  });
  if (!xudtCells || xudtCells.length === 0) {
    throw new NoXudtLiveCellError('The address has no xudt cells');
  }
  console.log('xudtCells: ', xudtCells)
  const sumTransferAmount = receivers
    .map((receiver) => receiver.transferAmount)
    .reduce((prev, current) => prev + current, BigInt(0));

  let {
    inputs,
    sumInputsCapacity: sumXudtInputsCapacity,
    sumAmount,
  } = collector.collectUdtInputs({
    liveCells: xudtCells,
    needAmount: sumTransferAmount,
  });
  let actualInputsCapacity = sumXudtInputsCapacity;

  const xudtCapacity = calculateUdtCellCapacity(fromLock);
  const sumXudtCapacity = xudtCapacity * BigInt(receivers.length);

  const outputs: CKBComponents.CellOutput[] = receivers.map((receiver) => ({
    lock: addressToScript(receiver.toAddress),
    type: xudtType,
    capacity: append0x(xudtCapacity.toString(16)),
  }));
  const outputsData = receivers.map((receiver) => append0x(u128ToLe(receiver.transferAmount)));

  let txFee = MAX_FEE;

  if (sumXudtInputsCapacity < sumXudtCapacity + txFee) {
    const emptyCells = await collector.getCells({
      lock: fromLock,
    });
    if (!emptyCells || emptyCells.length === 0) {
      throw new NoLiveCellError('The address has no empty cells');
    }
    const needCapacity = sumXudtCapacity - sumXudtInputsCapacity + xudtCapacity;
    const { inputs: emptyInputs, sumInputsCapacity: sumEmptyCapacity } = collector.collectInputs(
      emptyCells,
      needCapacity,
      txFee,
      { minCapacity: MIN_CAPACITY },
    );
    inputs = [...inputs, ...emptyInputs];
    actualInputsCapacity += sumEmptyCapacity;
  }

  let changeCapacity = actualInputsCapacity - sumXudtCapacity;
  console.log('changeCapacity', changeCapacity)
  console.log('actualInputsCapacity', actualInputsCapacity)
  console.log('sumXudtCapacity', sumXudtCapacity)
  if (sumAmount > sumTransferAmount) {
    outputs.push({
      lock: fromLock,
      type: xudtType,
      capacity: append0x(xudtCapacity.toString(16)),
    });
    outputsData.push(append0x(u128ToLe(sumAmount - sumTransferAmount)));
    changeCapacity -= xudtCapacity;
  }

  if (changeCapacity > 0) {
    outputs.push({
      lock: fromLock,
      type: xudtType,
      capacity: append0x(changeCapacity.toString(16)),
    });
  }


  if (outputsData.length < outputs.length) {
    outputsData.push('0x');
  }

  console.log('inputs', inputs)

  console.log('outputs', outputs)
  console.log('outputsData', outputsData)

  const emptyWitness = { lock: '', inputType: '', outputType: '' };
  const witnesses = inputs.map((_, index) => (index === 0 ? emptyWitness : '0x'));

  const cellDeps = [getSecp256k1CellDep(isMainnet), getUniqueTypeDep(isMainnet), getXudtDep(isMainnet)];

  const unsignedTx = {
    version: '0x0',
    cellDeps,
    headerDeps: [],
    inputs,
    outputs,
    outputsData,
    witnesses,
  };

  if (txFee === MAX_FEE) {
    const txSize = getTransactionSize(unsignedTx) + SECP256K1_WITNESS_LOCK_SIZE;
    const estimatedTxFee = calculateTransactionFee(txSize);
    changeCapacity -= estimatedTxFee;
    unsignedTx.outputs[unsignedTx.outputs.length - 1].capacity = append0x(changeCapacity.toString(16));
  }

  const signedTx = collector.getCkb().signTransaction(CKB_TEST_PRIVATE_KEY)(unsignedTx);
  console.log('signedTx', signedTx)
  const txHash = await collector.getCkb().rpc.sendTransaction(signedTx, 'passthrough');

  console.info(`xUDT asset has been minted or transferred and tx hash is ${txHash}`);
};
const xudtType = {
  codeHash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb',
  hashType: 'type',
  args: '0xbd23085b46a45fdeaf08010bc3b65b657e3175624258183cd279e866353e31f3'
}
/*
transferXudt({
  // The xudtType comes from 1-issue-xudt
  xudtType: {
    codeHash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb',
    hashType: 'type',
    args: '0xbd23085b46a45fdeaf08010bc3b65b657e3175624258183cd279e866353e31f3'
  },
  receivers: [
    {
      toAddress,
      transferAmount: BigInt(100) * BigInt(10 ** XUDT_TOKEN_INFO.decimal),
    },
    {
      toAddress,
      transferAmount: BigInt(200) * BigInt(10 ** XUDT_TOKEN_INFO.decimal),
    },
  ],
});

*/

/**
 * transferXudt can be used to mint xUDT assets or transfer xUDT assets.
 * @param: xudtType The xUDT type script that comes from 1-issue-xudt
 * @param: receivers The receiver includes toAddress and transferAmount
 */
/*
const merge = async (receiver: string, xudtType: CKBComponents.Script) => {
  const collector = new Collector({
    ckbNodeUrl: 'https://testnet.ckb.dev/rpc',
    ckbIndexerUrl: 'https://testnet.ckb.dev/indexer',
  });
  const isMainnet = false;
  const fromAddress = privateKeyToAddress(CKB_TEST_PRIVATE_KEY, {
    prefix: isMainnet ? AddressPrefix.Mainnet : AddressPrefix.Testnet,
  });
  console.log('ckb address: ', fromAddress);

  const fromLock = addressToScript(fromAddress);

  const xudtCells = await collector.getCells({
    lock: fromLock,
    type: xudtType,
  });
  if (!xudtCells || xudtCells.length === 0) {
    throw new NoXudtLiveCellError('The address has no xudt cells');
  }
  const sumTransferAmount = receivers
    .map((receiver) => receiver.transferAmount)
    .reduce((prev, current) => prev + current, BigInt(0));

  let {
    inputs,
    sumInputsCapacity: sumXudtInputsCapacity,
    sumAmount,
  } = collector.collectUdtInputs({
    liveCells: xudtCells,
    needAmount: sumTransferAmount,
  });
  let actualInputsCapacity = sumXudtInputsCapacity;

  const xudtCapacity = calculateUdtCellCapacity(fromLock);
  const sumXudtCapacity = xudtCapacity * BigInt(receivers.length);

  const outputs: CKBComponents.CellOutput[] = receivers.map((receiver) => ({
    lock: addressToScript(receiver.toAddress),
    type: xudtType,
    capacity: append0x(xudtCapacity.toString(16)),
  }));
  const outputsData = receivers.map((receiver) => append0x(u128ToLe(receiver.transferAmount)));

  let txFee = MAX_FEE;
  if (sumXudtInputsCapacity < sumXudtCapacity) {
    const emptyCells = await collector.getCells({
      lock: fromLock,
    });
    if (!emptyCells || emptyCells.length === 0) {
      throw new NoLiveCellError('The address has no empty cells');
    }
    const needCapacity = sumXudtCapacity - sumXudtInputsCapacity + xudtCapacity;
    const { inputs: emptyInputs, sumInputsCapacity: sumEmptyCapacity } = collector.collectInputs(
      emptyCells,
      needCapacity,
      txFee,
      { minCapacity: MIN_CAPACITY },
    );
    inputs = [...inputs, ...emptyInputs];
    actualInputsCapacity += sumEmptyCapacity;
  }

  let changeCapacity = actualInputsCapacity - sumXudtCapacity;
  if (sumAmount > sumTransferAmount) {
    outputs.push({
      lock: fromLock,
      type: xudtType,
      capacity: append0x(xudtCapacity.toString(16)),
    });
    outputsData.push(append0x(u128ToLe(sumAmount - sumTransferAmount)));
    changeCapacity -= xudtCapacity;
  }

  outputs.push({
    lock: fromLock,
    type: xudtType,
    capacity: append0x(changeCapacity.toString(16)),
  });
  outputsData.push('0x');

  const emptyWitness = { lock: '', inputType: '', outputType: '' };
  const witnesses = inputs.map((_, index) => (index === 0 ? emptyWitness : '0x'));

  const cellDeps = [getSecp256k1CellDep(isMainnet), getUniqueTypeDep(isMainnet), getXudtDep(isMainnet)];

  const unsignedTx = {
    version: '0x0',
    cellDeps,
    headerDeps: [],
    inputs,
    outputs,
    outputsData,
    witnesses,
  };

  if (txFee === MAX_FEE) {
    const txSize = getTransactionSize(unsignedTx) + SECP256K1_WITNESS_LOCK_SIZE;
    const estimatedTxFee = calculateTransactionFee(txSize);
    changeCapacity -= estimatedTxFee;
    unsignedTx.outputs[unsignedTx.outputs.length - 1].capacity = append0x(changeCapacity.toString(16));
  }

  const signedTx = collector.getCkb().signTransaction(CKB_TEST_PRIVATE_KEY)(unsignedTx);
  const txHash = await collector.getCkb().rpc.sendTransaction(signedTx, 'passthrough');

  console.info(`xUDT asset has been minted or transferred and tx hash is ${txHash}`);
};
*/

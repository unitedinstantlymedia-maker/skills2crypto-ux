import { MockEscrowAdapter, mockEscrowAdapter } from './MockEscrowAdapter';
import { EvmEscrowAdapter, evmEscrowAdapter } from './EvmEscrowAdapter';

const USE_MOCK = import.meta.env.VITE_USE_MOCK_ESCROW !== 'false';

export type EscrowAdapter = MockEscrowAdapter | EvmEscrowAdapter;

export const escrowAdapter: EscrowAdapter = USE_MOCK ? mockEscrowAdapter : evmEscrowAdapter;

export { MockEscrowAdapter, mockEscrowAdapter } from './MockEscrowAdapter';
export { EvmEscrowAdapter, evmEscrowAdapter } from './EvmEscrowAdapter';

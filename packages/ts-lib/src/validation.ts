/**
 * Input Validation Module
 *
 * Provides validation and sanitization utilities for user input,
 * particularly Ethereum addresses and nicknames. These functions
 * help prevent SQL injection, XSS, and other security vulnerabilities.
 *
 * @module validation
 */

/**
 * Checks if a string is a valid Ethereum address format.
 * Validates that the address starts with '0x' followed by exactly 40 hex characters.
 *
 * @param address - The string to validate
 * @returns true if valid Ethereum address format, false otherwise
 *
 * @example
 * ```typescript
 * isValidEthereumAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f4f123') // true
 * isValidEthereumAddress('invalid') // false
 * isValidEthereumAddress('0x123') // false (too short)
 * ```
 */
export function isValidEthereumAddress(address: string): boolean {
  if (typeof address !== 'string') return false;
  // Ethereum address: 0x followed by 40 hex characters
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Validates and normalizes an Ethereum address.
 * Throws an error if the address is invalid; returns lowercase address if valid.
 *
 * @param address - The address to validate
 * @returns The address in lowercase format
 * @throws Error if the address is not a valid Ethereum address
 *
 * @example
 * ```typescript
 * validateEthereumAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f4f123')
 * // Returns: '0x742d35cc6634c0532925a3b844bc9e7595f4f123'
 * ```
 */
export function validateEthereumAddress(address: string): string {
  if (!isValidEthereumAddress(address)) {
    throw new Error(`Invalid Ethereum address: ${address}`);
  }
  return address.toLowerCase();
}

/**
 * Validates an array of Ethereum addresses.
 * Ensures the input is a non-empty array of valid addresses (max 1000).
 *
 * @param addresses - Unknown input to validate as address array
 * @returns Array of validated, lowercase addresses
 * @throws Error if input is not an array, is empty, exceeds 1000 items,
 *         or contains invalid addresses
 *
 * @example
 * ```typescript
 * validateAddressArray(['0x742d35Cc...', '0x123abc...'])
 * // Returns: ['0x742d35cc...', '0x123abc...']
 * ```
 */
export function validateAddressArray(addresses: unknown): string[] {
  if (!Array.isArray(addresses)) {
    throw new Error('Addresses must be an array');
  }
  if (addresses.length === 0) {
    throw new Error('Addresses array cannot be empty');
  }
  if (addresses.length > 1000) {
    throw new Error('Addresses array too large (max 1000)');
  }

  return addresses.map((addr, idx) => {
    if (typeof addr !== 'string') {
      throw new Error(`Address at index ${idx} must be a string`);
    }
    if (!isValidEthereumAddress(addr)) {
      throw new Error(`Invalid Ethereum address at index ${idx}: ${addr}`);
    }
    return addr.toLowerCase();
  });
}

/**
 * Sanitizes a nickname string for safe storage and display.
 * Removes potentially dangerous characters to prevent XSS attacks.
 *
 * @param nickname - Unknown input to sanitize
 * @returns Sanitized nickname string, or null if empty/null
 * @throws Error if nickname is not a string or exceeds 100 characters
 *
 * @example
 * ```typescript
 * sanitizeNickname('Trader<script>') // Returns: 'Traderscript'
 * sanitizeNickname(null) // Returns: null
 * sanitizeNickname('') // Returns: null
 * ```
 */
export function sanitizeNickname(nickname: unknown): string | null {
  if (nickname == null || nickname === '') return null;
  if (typeof nickname !== 'string') {
    throw new Error('Nickname must be a string');
  }
  const trimmed = nickname.trim();
  if (trimmed.length > 100) {
    throw new Error('Nickname too long (max 100 characters)');
  }
  // Remove potentially dangerous characters
  return trimmed.replace(/[<>\"']/g, '');
}

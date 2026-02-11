// Polyfill Uint8Array.prototype.toHex for Node.js < 25
// Required by @n1xyz/nord-ts for session signing

export {};

declare global {
	interface Uint8Array {
		toHex(): string;
	}
}

if (typeof Uint8Array.prototype.toHex !== "function") {
	Uint8Array.prototype.toHex = function () {
		let hex = "";
		for (let i = 0; i < this.length; i++) {
			hex += this[i].toString(16).padStart(2, "0");
		}
		return hex;
	};
}

// Fair Price Provider interface (Dependency Inversion)
export interface FairPriceProvider {
	/** Record price sample from local and reference exchanges */
	addSample(localMid: number, referenceMid: number): void;
	/** Calculate fair price based on reference price + median offset */
	getFairPrice(referenceMid: number): number | null;
	/** Get current median offset (local - reference), null if insufficient samples */
	getMedianOffset(): number | null;
	/** Get raw median offset (ignores minSamples, for display during warmup) */
	getRawMedianOffset(): number | null;
	/** Get number of valid samples in window */
	getSampleCount(): number;
	/** Get current state for debugging */
	getState(): { offset: number | null; samples: number };
}

// Offset-median fair price calculator
// fair_price = reference_mid + median(local_mid - reference_mid)
// Samples at 200ms resolution (5x more granular than 1-per-second)

const SAMPLE_INTERVAL_MS = 200; // One sample per 200ms slot
const MAX_SAMPLES = 2500; // 5 minutes * (1000/200) slots/sec + buffer

export interface FairPriceConfig {
	readonly windowMs: number; // Time window for samples (5 min = 300,000ms)
	readonly minSamples: number; // Min samples before producing fair price
}

interface OffsetSample {
	offset: number; // zo_mid - binance_mid
	slot: number; // Time slot: Math.floor(timestamp / SAMPLE_INTERVAL_MS)
}

export class FairPriceCalculator implements FairPriceProvider {
	// Circular buffer: fixed-size array with head pointer
	private samples: OffsetSample[] = [];
	private head = 0; // Next write position
	private count = 0; // Actual sample count
	private lastSlot = 0; // Last recorded time slot

	constructor(private readonly config: FairPriceConfig) {}

	// Add a new sample when both prices are available (once per 200ms slot)
	addSample(localMid: number, referenceMid: number): void {
		const now = Date.now();
		const currentSlot = Math.floor(now / SAMPLE_INTERVAL_MS);

		// One sample per 200ms slot
		if (currentSlot <= this.lastSlot) {
			return;
		}
		this.lastSlot = currentSlot;

		const offset = localMid - referenceMid;

		// Write to circular buffer
		this.samples[this.head] = { offset, slot: currentSlot };
		this.head = (this.head + 1) % MAX_SAMPLES;
		if (this.count < MAX_SAMPLES) {
			this.count++;
		}
	}

	// Get samples within time window
	private getValidSamples(): OffsetSample[] {
		const cutoffSlot = Math.floor((Date.now() - this.config.windowMs) / SAMPLE_INTERVAL_MS);
		const valid: OffsetSample[] = [];

		for (let i = 0; i < this.count; i++) {
			const sample = this.samples[i];
			if (sample && sample.slot > cutoffSlot) {
				valid.push(sample);
			}
		}

		return valid;
	}

	// Get median offset from samples
	getMedianOffset(): number | null {
		const valid = this.getValidSamples();

		if (valid.length < this.config.minSamples) {
			return null;
		}

		const offsets = valid.map((s) => s.offset).sort((a, b) => a - b);
		const mid = Math.floor(offsets.length / 2);

		if (offsets.length % 2 === 0) {
			return (offsets[mid - 1] + offsets[mid]) / 2;
		}
		return offsets[mid];
	}

	// Calculate fair price: reference + median(local - reference)
	getFairPrice(referenceMid: number): number | null {
		const offset = this.getMedianOffset();
		if (offset === null) return null;
		return referenceMid + offset;
	}

	getSampleCount(): number {
		return this.getValidSamples().length;
	}

	// Get raw median offset (ignores minSamples, for display during warmup)
	getRawMedianOffset(): number | null {
		const valid = this.getValidSamples();
		if (valid.length === 0) return null;

		const offsets = valid.map((s) => s.offset).sort((a, b) => a - b);
		const mid = Math.floor(offsets.length / 2);

		if (offsets.length % 2 === 0) {
			return (offsets[mid - 1] + offsets[mid]) / 2;
		}
		return offsets[mid];
	}

	// For debugging
	getState(): { offset: number | null; samples: number } {
		return {
			offset: this.getRawMedianOffset(),
			samples: this.getSampleCount(),
		};
	}
}

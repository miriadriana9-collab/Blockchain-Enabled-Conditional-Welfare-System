// payment-dispatcher.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { stringAsciiCV, uintCV } from "@stacks/transactions";

const ERR_NOT_VERIFIED = 100;
const ERR_ALREADY_PAID = 101;
const ERR_INSUFFICIENT_FUNDS = 102;
const ERR_INVALID_BENEFICIARY = 103;
const ERR_INVALID_MILESTONE = 104;
const ERR_INVALID_AMOUNT = 105;
const ERR_POOL_NOT_FUNDED = 106;
const ERR_ORACLE_FAILED = 107;
const ERR_CLAIM_NOT_SUBMITTED = 108;
const ERR_GOVERNANCE_NOT_APPROVED = 109;
const ERR_INVALID_CLAIM_ID = 110;
const ERR_PAYMENT_EXCEEDS_MAX = 111;
const ERR_TIMESTAMP_EXPIRED = 112;
const ERR_BENEFICIARY_NOT_REGISTERED = 113;
const ERR_MILESTONE_NOT_ACHIEVED = 114;

interface Claim {
  beneficiary: string;
  milestoneId: number;
  proofHash: string;
  submitted: number;
}

interface Payment {
  paid: boolean;
  amount: number;
  timestamp: number;
  claimId: number;
}

interface MilestoneReward {
  rewardAmount: number;
  maxClaims: number;
  active: boolean;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

class PaymentDispatcherMock {
  state: {
    poolBalance: number;
    maxPaymentPerClaim: number;
    governanceToken: string;
    oracleContract: string | null;
    payments: Map<string, Payment>;
    claims: Map<number, Claim>;
    milestoneRewards: Map<number, MilestoneReward>;
  } = {
    poolBalance: 0,
    maxPaymentPerClaim: 10000,
    governanceToken: "SP000000000000000000002Q6VF78",
    oracleContract: null,
    payments: new Map(),
    claims: new Map(),
    milestoneRewards: new Map(),
  };
  blockHeight: number = 0;
  caller: string = "ST1TEST";
  stxTransfers: Array<{ amount: number; from: string; to: string }> = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      poolBalance: 0,
      maxPaymentPerClaim: 10000,
      governanceToken: "SP000000000000000000002Q6VF78",
      oracleContract: null,
      payments: new Map(),
      claims: new Map(),
      milestoneRewards: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1TEST";
    this.stxTransfers = [];
  }

  setOracleContract(ora: string): Result<boolean> {
    if (this.caller !== this.state.governanceToken)
      return { ok: false, value: false };
    this.state.oracleContract = ora;
    return { ok: true, value: true };
  }

  setMaxPaymentPerClaim(max: number): Result<boolean> {
    if (this.caller !== this.state.governanceToken)
      return { ok: false, value: false };
    if (max <= 0) return { ok: false, value: false };
    this.state.maxPaymentPerClaim = max;
    return { ok: true, value: true };
  }

  fundPool(amt: number): Result<boolean> {
    if (amt <= 0) return { ok: false, value: false };
    this.state.poolBalance += amt;
    this.stxTransfers.push({ amount: amt, from: this.caller, to: "contract" });
    return { ok: true, value: true };
  }

  submitClaim(cid: number, mid: number, proof: string): Result<number> {
    if (cid <= 0) return { ok: false, value: ERR_INVALID_CLAIM_ID };
    if (mid <= 0) return { ok: false, value: ERR_INVALID_MILESTONE };
    if (this.state.claims.has(cid))
      return { ok: false, value: ERR_CLAIM_NOT_SUBMITTED };
    this.state.claims.set(cid, {
      beneficiary: this.caller,
      milestoneId: mid,
      proofHash: proof,
      submitted: this.blockHeight,
    });
    return { ok: true, value: cid };
  }

  dispatchPayment(cid: number): Result<number> {
    const claim = this.state.claims.get(cid);
    if (!claim) return { ok: false, value: ERR_INVALID_CLAIM_ID };
    const ben = claim.beneficiary;
    const mid = claim.milestoneId;
    const timestamp = claim.submitted;
    const reward = this.state.milestoneRewards.get(mid);
    if (!reward) return { ok: false, value: ERR_INVALID_MILESTONE };
    const amt = reward.rewardAmount;
    if (ben !== this.caller)
      return { ok: false, value: ERR_INVALID_BENEFICIARY };
    if (amt <= 0 || amt > this.state.maxPaymentPerClaim)
      return { ok: false, value: ERR_INVALID_AMOUNT };
    if (this.state.poolBalance < amt)
      return { ok: false, value: ERR_INSUFFICIENT_FUNDS };
    const paymentKey = `${ben}-${mid}`;
    if (this.state.payments.has(paymentKey))
      return { ok: false, value: ERR_ALREADY_PAID };
    if (this.blockHeight < timestamp + 86400)
      return { ok: false, value: ERR_TIMESTAMP_EXPIRED };
    if (!this.state.oracleContract)
      return { ok: false, value: ERR_NOT_VERIFIED };
    if (!reward.active) return { ok: false, value: ERR_MILESTONE_NOT_ACHIEVED };
    this.state.poolBalance -= amt;
    this.stxTransfers.push({ amount: amt, from: "contract", to: ben });
    this.state.payments.set(paymentKey, {
      paid: true,
      amount: amt,
      timestamp: this.blockHeight,
      claimId: cid,
    });
    return { ok: true, value: amt };
  }

  setMilestoneReward(mid: number, amt: number, maxc: number): Result<boolean> {
    if (this.caller !== this.state.governanceToken)
      return { ok: false, value: false };
    if (mid <= 0) return { ok: false, value: false };
    if (amt <= 0) return { ok: false, value: false };
    this.state.milestoneRewards.set(mid, {
      rewardAmount: amt,
      maxClaims: maxc,
      active: true,
    });
    return { ok: true, value: true };
  }

  deactivateMilestone(mid: number): Result<boolean> {
    if (this.caller !== this.state.governanceToken)
      return { ok: false, value: false };
    if (mid <= 0) return { ok: false, value: false };
    const reward = this.state.milestoneRewards.get(mid);
    if (!reward) return { ok: false, value: false };
    this.state.milestoneRewards.set(mid, { ...reward, active: false });
    return { ok: true, value: true };
  }

  withdrawExcess(amt: number): Result<boolean> {
    if (this.caller !== this.state.governanceToken)
      return { ok: false, value: false };
    if (amt <= 0) return { ok: false, value: false };
    if (this.state.poolBalance < amt) return { ok: false, value: false };
    this.state.poolBalance -= amt;
    this.stxTransfers.push({
      amount: amt,
      from: "contract",
      to: this.state.governanceToken,
    });
    return { ok: true, value: true };
  }

  getPaymentStatus(ben: string, mid: number): Payment | null {
    return this.state.payments.get(`${ben}-${mid}`) || null;
  }

  getClaimDetails(cid: number): Claim | null {
    return this.state.claims.get(cid) || null;
  }

  getPoolBalance(): number {
    return this.state.poolBalance;
  }

  getMaxPayment(): number {
    return this.state.maxPaymentPerClaim;
  }
}

describe("PaymentDispatcher", () => {
  let contract: PaymentDispatcherMock;

  beforeEach(() => {
    contract = new PaymentDispatcherMock();
    contract.reset();
  });

  it("funds the pool successfully", () => {
    const result = contract.fundPool(5000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getPoolBalance()).toBe(5000);
    expect(contract.stxTransfers).toEqual([
      { amount: 5000, from: "ST1TEST", to: "contract" },
    ]);
  });

  it("rejects funding with invalid amount", () => {
    const result = contract.fundPool(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("submits a claim successfully", () => {
    const result = contract.submitClaim(1, 1, "proof123");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(1);
    const claim = contract.getClaimDetails(1);
    expect(claim?.beneficiary).toBe("ST1TEST");
    expect(claim?.milestoneId).toBe(1);
    expect(claim?.proofHash).toBe("proof123");
    expect(claim?.submitted).toBe(0);
  });

  it("rejects submit claim with invalid claim id", () => {
    const result = contract.submitClaim(0, 1, "proof123");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_CLAIM_ID);
  });

  it("rejects duplicate claim submission", () => {
    contract.submitClaim(1, 1, "proof123");
    const result = contract.submitClaim(1, 2, "proof456");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_CLAIM_NOT_SUBMITTED);
  });

  it("sets milestone reward successfully", () => {
    contract.caller = "SP000000000000000000002Q6VF78";
    const result = contract.setMilestoneReward(1, 1000, 10);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const reward = contract.state.milestoneRewards.get(1);
    expect(reward?.rewardAmount).toBe(1000);
    expect(reward?.maxClaims).toBe(10);
    expect(reward?.active).toBe(true);
  });

  it("rejects set milestone reward by non-governance", () => {
    const result = contract.setMilestoneReward(1, 1000, 10);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects dispatch without claim", () => {
    const result = contract.dispatchPayment(1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_CLAIM_ID);
  });

  it("sets max payment per claim successfully", () => {
    contract.caller = "SP000000000000000000002Q6VF78";
    const result = contract.setMaxPaymentPerClaim(5000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getMaxPayment()).toBe(5000);
  });

  it("rejects set max payment by non-governance", () => {
    const result = contract.setMaxPaymentPerClaim(5000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("deactivates milestone successfully", () => {
    contract.caller = "SP000000000000000000002Q6VF78";
    contract.setMilestoneReward(1, 1000, 10);
    const result = contract.deactivateMilestone(1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const reward = contract.state.milestoneRewards.get(1);
    expect(reward?.active).toBe(false);
  });

  it("rejects deactivate milestone by non-governance", () => {
    contract.setMilestoneReward(1, 1000, 10);
    const result = contract.deactivateMilestone(1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("withdraws excess successfully", () => {
    contract.caller = "SP000000000000000000002Q6VF78";
    contract.fundPool(10000);
    const result = contract.withdrawExcess(2000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getPoolBalance()).toBe(8000);
    expect(contract.stxTransfers.length).toBe(2);
    expect(contract.stxTransfers[1].amount).toBe(2000);
  });

  it("rejects withdraw excess with insufficient funds", () => {
    contract.caller = "SP000000000000000000002Q6VF78";
    contract.fundPool(1000);
    const result = contract.withdrawExcess(2000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("parses claim proof with Clarity", () => {
    const proof = stringAsciiCV("proof123");
    expect(proof.value).toBe("proof123");
  });
});

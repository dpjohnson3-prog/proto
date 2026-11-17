import XCTest
import StoreKit
import StoreKitTest
@testable import App

/// Exercises DawnStorePlugin's entitlement logic against Dawn.storekit with
/// StoreKit Testing (adapted from Mysterium's StoreKitTests).
final class StoreKitTests: XCTestCase {
    let yearly = "dawn.premium.yearly"
    let monthly = "dawn.premium.monthly"
    let lifetime = "dawn.premium.lifetime"
    var session: SKTestSession!
    let plugin = DawnStorePlugin()

    override func setUp() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Dawn.storekit")
        session = try SKTestSession(contentsOf: url)
        session.disableDialogs = true
        session.resetToDefaultState()
        session.clearTransactions()
    }

    func ent() async -> [String: Any] { await plugin.currentEntitlement() }
    func active() async -> Bool? { await ent()["active"] as? Bool }

    func testAllThreeProductsLoad() async throws {
        let products = try await Product.products(for: [yearly, monthly, lifetime])
        XCTAssertEqual(products.count, 3)
        let l = try XCTUnwrap(products.first { $0.id == lifetime })
        XCTAssertEqual(l.type, .nonConsumable)
        XCTAssertEqual(l.price, Decimal(string: "59.99"))
        let m = try XCTUnwrap(products.first { $0.id == monthly })
        XCTAssertNil(m.subscription?.introductoryOffer, "monthly has no trial")
    }

    func testFreshUserIsNotPremiumAndSeesTrial() async throws {
        let a = await active(); XCTAssertEqual(a, false)
        let y = try XCTUnwrap(try await Product.products(for: [yearly]).first)
        XCTAssertEqual(y.subscription?.introductoryOffer?.paymentMode, .freeTrial)
        let period = try XCTUnwrap(y.subscription?.introductoryOffer?.period)
        let days = period.unit == .week ? period.value * 7 : (period.unit == .day ? period.value : -1)
        XCTAssertEqual(days, 7)
        let eligible = await y.subscription?.isEligibleForIntroOffer
        XCTAssertEqual(eligible, true)
    }

    func testBuyYearlyStartsTrialOnce() async throws {
        try await session.buyProduct(identifier: yearly)
        let e = await ent()
        XCTAssertEqual(e["active"] as? Bool, true)
        XCTAssertEqual(e["inTrial"] as? Bool, true)
        XCTAssertEqual(e["productId"] as? String, yearly)
        XCTAssertEqual(e["lifetime"] as? Bool, false)
        let y = try await Product.products(for: [yearly]).first!
        let eligible = await y.subscription?.isEligibleForIntroOffer
        XCTAssertEqual(eligible, false, "the trial is offered once")
    }

    func testBuyMonthlyHasNoTrial() async throws {
        try await session.buyProduct(identifier: monthly)
        let e = await ent()
        XCTAssertEqual(e["active"] as? Bool, true)
        XCTAssertEqual(e["inTrial"] as? Bool, false)
        XCTAssertEqual(e["productId"] as? String, monthly)
    }

    func testLifetimeUnlocksWithNoExpiry() async throws {
        try await session.buyProduct(identifier: lifetime)
        let e = await ent()
        XCTAssertEqual(e["active"] as? Bool, true)
        XCTAssertEqual(e["lifetime"] as? Bool, true)
        XCTAssertEqual(e["productId"] as? String, lifetime)
        XCTAssertNil(e["expires"])
    }

    func testExpiryRemovesSubscriptionAccess() async throws {
        try await session.buyProduct(identifier: monthly)
        let a1 = await active(); XCTAssertEqual(a1, true)
        try session.expireSubscription(productIdentifier: monthly)
        try await Task.sleep(nanoseconds: 3_000_000_000)
        let a2 = await active(); XCTAssertEqual(a2, false)
    }

    func testLifetimeSurvivesAnExpiredSubscription() async throws {
        try await session.buyProduct(identifier: monthly)
        try await session.buyProduct(identifier: lifetime)
        try session.expireSubscription(productIdentifier: monthly)
        try await Task.sleep(nanoseconds: 3_000_000_000)
        let e = await ent()
        XCTAssertEqual(e["active"] as? Bool, true)
        XCTAssertEqual(e["lifetime"] as? Bool, true)
    }

    func testRefundRemovesSubscriptionAccess() async throws {
        try await session.buyProduct(identifier: yearly)
        let a1 = await active(); XCTAssertEqual(a1, true)
        let t = try XCTUnwrap(session.allTransactions().last)
        try await session.refundTransaction(identifier: UInt(t.identifier))
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let a2 = await active(); XCTAssertEqual(a2, false)
    }

    func testRefundRemovesLifetimeAccess() async throws {
        try await session.buyProduct(identifier: lifetime)
        let t = try XCTUnwrap(session.allTransactions().last)
        try await session.refundTransaction(identifier: UInt(t.identifier))
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let a = await active(); XCTAssertEqual(a, false)
    }

    func testRenewalKeepsAccess() async throws {
        session.timeRate = .monthlyRenewalEveryThirtySeconds
        try await session.buyProduct(identifier: monthly)
        try await Task.sleep(nanoseconds: 35_000_000_000)
        let a = await active(); XCTAssertEqual(a, true, "still active after an automatic renewal")
        session.timeRate = .realTime
    }

    func testBillingRetryWithoutGraceRemovesAccess() async throws {
        session.billingGracePeriodIsEnabled = false
        session.shouldEnterBillingRetryOnRenewal = true
        session.timeRate = .monthlyRenewalEveryThirtySeconds
        try await session.buyProduct(identifier: monthly)
        try await Task.sleep(nanoseconds: 35_000_000_000)
        let e = await ent()
        XCTAssertEqual(e["active"] as? Bool, false)
        session.timeRate = .realTime
    }

    func testGracePeriodKeepsAccess() async throws {
        session.billingGracePeriodIsEnabled = true
        session.shouldEnterBillingRetryOnRenewal = true
        session.timeRate = .monthlyRenewalEveryThirtySeconds
        try await session.buyProduct(identifier: monthly)
        try await Task.sleep(nanoseconds: 35_000_000_000)
        let e = await ent()
        XCTAssertEqual(e["active"] as? Bool, true, "grace period keeps Premium while Apple retries the card")
        XCTAssertEqual(e["inGracePeriod"] as? Bool, true)
        session.timeRate = .realTime
    }
}

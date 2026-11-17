//
//  DawnStore.swift
//  StoreKit 2 bridge for Dawn Premium. Adapted from Mysterium's
//  MysteriumStorePlugin. No third-party SDKs: nothing leaves the device
//  except the App Store's own purchase traffic, so the App Store privacy
//  label stays "Data Not Collected".
//
//  Premium is unlocked by EITHER an active subscription in the "Dawn Premium"
//  group (monthly / yearly) OR the Lifetime non-consumable - including a
//  Lifetime redeemed from an offer code given to a creator. Only VERIFIED
//  transactions count; revoked (refunded) ones never do.
//
import Foundation
import Capacitor
import StoreKit
import UIKit

@objc(DawnStorePlugin)
public class DawnStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DawnStorePlugin"
    public let jsName = "DawnStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "entitlement", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "redeemCode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appTransaction", returnType: CAPPluginReturnPromise),
    ]

    static let yearly = "dawn.premium.yearly"
    static let monthly = "dawn.premium.monthly"
    static let lifetime = "dawn.premium.lifetime"
    static let subscriptionIDs = [yearly, monthly]
    static let productIDs = [yearly, monthly, lifetime]

    private var updatesTask: Task<Void, Never>?

    public override func load() {
        // Listen from launch so renewals, refunds, Ask-to-Buy approvals and
        // codes redeemed in the App Store app are never missed.
        updatesTask = Task.detached { [weak self] in
            for await result in Transaction.updates {
                guard let self else { return }
                if case .verified(let transaction) = result {
                    await transaction.finish()
                }
                let state = await self.currentEntitlement()
                self.notifyListeners("entitlementChanged", data: state)
            }
        }
        // Settle anything left unfinished from a previous run.
        Task.detached {
            for await result in Transaction.unfinished {
                if case .verified(let transaction) = result { await transaction.finish() }
            }
        }
    }

    deinit { updatesTask?.cancel() }

    // MARK: - Entitlement

    /// Active if a verified, unrevoked Lifetime purchase exists, or a verified,
    /// unrevoked, unexpired subscription transaction exists, or the
    /// subscription is in its billing grace period. Billing retry without
    /// grace, expired and refunded subscriptions are not active.
    /// Transaction.currentEntitlements is answered from the device's signed
    /// transaction store, so this works offline too.
    func currentEntitlement() async -> [String: Any] {
        var lifetime = false
        var best: Transaction?
        for await result in Transaction.currentEntitlements {
            guard case .verified(let t) = result, t.revocationDate == nil else { continue }
            if t.productID == Self.lifetime { lifetime = true; continue }
            guard Self.subscriptionIDs.contains(t.productID) else { continue }
            if let exp = t.expirationDate, exp <= Date() { continue }
            if best == nil || (t.expirationDate ?? .distantFuture) > (best!.expirationDate ?? .distantFuture) { best = t }
        }

        // Renewal state needs the network; offline this is simply skipped.
        var willRenew = false
        var inGrace = false
        var inRetry = false
        var statusProduct: String?
        var statusExpiry: Date?
        if let products = try? await Product.products(for: Self.subscriptionIDs),
           let group = products.first(where: { $0.subscription != nil })?.subscription,
           let statuses = try? await group.status {
            for s in statuses {
                guard case .verified(let t) = s.transaction else { continue }
                if t.revocationDate != nil { continue }
                switch s.state {
                case .subscribed:
                    if case .verified(let info) = s.renewalInfo { willRenew = info.willAutoRenew }
                    statusProduct = t.productID; statusExpiry = t.expirationDate
                case .inGracePeriod:
                    inGrace = true
                    if case .verified(let info) = s.renewalInfo { willRenew = info.willAutoRenew }
                    statusProduct = t.productID; statusExpiry = t.expirationDate
                case .inBillingRetryPeriod:
                    inRetry = true
                default: break
                }
            }
        }

        let active = lifetime || best != nil || inGrace
        var out: [String: Any] = [
            "active": active,
            "lifetime": lifetime,
            "inGracePeriod": inGrace,
            "inBillingRetry": inRetry,
            "willRenew": willRenew,
            "inTrial": best?.offerType == .introductory,
        ]
        if lifetime { out["productId"] = Self.lifetime }
        else if let p = best?.productID ?? statusProduct { out["productId"] = p }
        if !lifetime, let exp = best?.expirationDate ?? statusExpiry {
            out["expires"] = Int(exp.timeIntervalSince1970 * 1000)
        }
        return out
    }

    @objc func entitlement(_ call: CAPPluginCall) {
        Task { call.resolve(await currentEntitlement()) }
    }

    // MARK: - v1.0 detection

    /// The App Store's signed record of this Apple ID's FIRST download of the
    /// app. originalAppVersion is the CFBundleVersion (build number) of that
    /// first download - "2" for anyone who installed Dawn 1.0 from the App
    /// Store. In the sandbox and Xcode it is always "1.0", so JS matches build
    /// numbers exactly and never grandfathers a test account by accident.
    /// Only a VERIFIED AppTransaction is reported.
    @objc func appTransaction(_ call: CAPPluginCall) {
        Task {
            do {
                let result = try await AppTransaction.shared
                guard case .verified(let t) = result else {
                    call.resolve(["verified": false]); return
                }
                call.resolve([
                    "verified": true,
                    "originalAppVersion": t.originalAppVersion,
                    "environment": t.environment.rawValue,
                    "originalPurchaseDate": Int(t.originalPurchaseDate.timeIntervalSince1970 * 1000),
                ])
            } catch {
                call.resolve(["verified": false, "error": "\(error)"])
            }
        }
    }

    // MARK: - Products

    private func describe(period: Product.SubscriptionPeriod) -> [String: Any] {
        let unit: String
        switch period.unit {
        case .day: unit = "day"
        case .week: unit = "week"
        case .month: unit = "month"
        case .year: unit = "year"
        @unknown default: unit = "day"
        }
        return ["unit": unit, "value": period.value]
    }

    @objc func products(_ call: CAPPluginCall) {
        Task {
            do {
                let list = try await Product.products(for: Self.productIDs)
                var out: [[String: Any]] = []
                for p in list {
                    var item: [String: Any] = [
                        "id": p.id,
                        "displayName": p.displayName,
                        "displayPrice": p.displayPrice,     // localized by StoreKit
                        "price": NSDecimalNumber(decimal: p.price).doubleValue,
                        "type": p.subscription != nil ? "subscription" : "lifetime",
                    ]
                    if let sub = p.subscription {
                        item["period"] = describe(period: sub.subscriptionPeriod)
                        if sub.subscriptionPeriod.unit == .year {
                            // Localized per-month equivalent in the buyer's own currency.
                            let perMonth = p.price / Decimal(12 * sub.subscriptionPeriod.value)
                            item["pricePerMonth"] = perMonth.formatted(p.priceFormatStyle)
                        }
                        if let intro = sub.introductoryOffer, intro.paymentMode == .freeTrial {
                            item["trial"] = describe(period: intro.period)
                            item["trialEligible"] = await sub.isEligibleForIntroOffer
                        }
                    }
                    out.append(item)
                }
                call.resolve(["products": out])
            } catch {
                call.reject("Could not load products: \(error.localizedDescription)", "network")
            }
        }
    }

    // MARK: - Purchase / restore / manage / redeem

    @objc func purchase(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), Self.productIDs.contains(id) else {
            call.reject("Unknown product"); return
        }
        Task {
            do {
                guard let product = try await Product.products(for: [id]).first else {
                    call.resolve(["status": "unavailable", "active": false]); return
                }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let t):
                        await t.finish()
                        var state = await currentEntitlement()
                        state["status"] = "success"
                        call.resolve(state)
                    case .unverified:
                        call.resolve(["status": "unverified", "active": false])
                    }
                case .pending:
                    call.resolve(["status": "pending", "active": false])
                case .userCancelled:
                    call.resolve(["status": "cancelled", "active": false])
                @unknown default:
                    call.resolve(["status": "unknown", "active": false])
                }
            } catch let error as StoreKitError {
                if case .networkError = error {
                    call.resolve(["status": "network", "active": false])
                } else if case .notAvailableInStorefront = error {
                    call.resolve(["status": "unavailable", "active": false])
                } else {
                    call.resolve(["status": "error", "active": false, "message": error.localizedDescription])
                }
            } catch let error as Product.PurchaseError {
                if case .purchaseNotAllowed = error {
                    call.resolve(["status": "notAllowed", "active": false])
                } else {
                    call.resolve(["status": "error", "active": false, "message": error.localizedDescription])
                }
            } catch {
                call.resolve(["status": "error", "active": false, "message": error.localizedDescription])
            }
        }
    }

    @objc func restore(_ call: CAPPluginCall) {
        Task {
            do {
                try await AppStore.sync()
                var state = await currentEntitlement()
                state["status"] = "ok"
                call.resolve(state)
            } catch let error as StoreKitError {
                if case .userCancelled = error {
                    var state = await currentEntitlement(); state["status"] = "cancelled"; call.resolve(state)
                } else if case .networkError = error {
                    var state = await currentEntitlement(); state["status"] = "network"; call.resolve(state)
                } else {
                    var state = await currentEntitlement(); state["status"] = "error"; call.resolve(state)
                }
            } catch {
                var state = await currentEntitlement(); state["status"] = "error"; call.resolve(state)
            }
        }
    }

    @MainActor private func activeScene() -> UIWindowScene? {
        UIApplication.shared.connectedScenes
            .first(where: { $0.activationState == .foregroundActive && $0 is UIWindowScene }) as? UIWindowScene
            ?? UIApplication.shared.connectedScenes.first(where: { $0 is UIWindowScene }) as? UIWindowScene
    }

    @objc func manage(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = activeScene() else { call.reject("No active window"); return }
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                call.resolve()
            } catch {
                call.reject("Could not open subscriptions: \(error.localizedDescription)")
            }
        }
    }

    /// Apple's own code-redemption sheet: subscription offer codes and
    /// one-time (Lifetime) offer codes alike. A redeemed code arrives through
    /// Transaction.updates, which notifies JS via "entitlementChanged".
    @objc func redeemCode(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = activeScene() else { call.reject("No active window"); return }
            do {
                try await AppStore.presentOfferCodeRedeemSheet(in: scene)
                call.resolve()
            } catch {
                call.reject("Could not open code redemption: \(error.localizedDescription)")
            }
        }
    }
}

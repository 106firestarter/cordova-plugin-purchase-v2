/*global storekit */
(function() {
    "use strict";
    
    //! ## Reacting to product state changes
    //!
    //! The iOS implementation monitors products changes of state to trigger
    //! `storekit` operations.
    //!
    //! Please refer to the [product life-cycle section](api.md#life-cycle) of the documentation
    //! for better understanding of the job of this event handlers.
    
    //! #### initialize storekit
    //! At first refresh, initialize the storekit API. See [`storekitInit()`](#storekitInit) for details.
    //!
    store.when("refreshed", function() {
        storekitInit(); // try to init if needed
        storekitLoad(); // try to load if needed
    });
    
    //! #### initiate a purchase
    //!
    //! When a product enters the store.REQUESTED state, initiate a purchase with `storekit`.
    //!
    store.when("requested", function(product) {
        store.ready(function() {
            if (!product) {
                store.error({
                    code: store.ERR_INVALID_PRODUCT_ID,
                    message: "Trying to order an unknown product"
                });
                return;
            }
            if (!product.valid) {
                product.trigger("error", [new store.Error({
                    code: store.ERR_PURCHASE,
                    message: "`purchase()` called with an invalid product"
                }), product]);
                return;
            }
            storekit.purchase(product.id, 1);
        });
    });
    
    
    //! #### finish a purchase
    //! When a product enters the store.FINISHED state, `finish()` the storekit transaction.
    //!
    store.when("finished", function(product) {
        store.log.debug("ios -> finishing " + product.id + " (a " + product.type + ")");
        storekitFinish(product);
        if (product.type === store.CONSUMABLE || product.type === store.NON_RENEWING_SUBSCRIPTION || product.expired) {
            product.set("state", store.VALID);
            setOwned(product.id, false);
        }
        else {
            product.set("state", store.OWNED);
        }
    });
    
    function storekitFinish(product) {
        if (product.type === store.CONSUMABLE || product.type === store.NON_RENEWING_SUBSCRIPTION) {
            var transactionId = (product.transaction && product.transaction.id) || storekit.transactionForProduct[product.id];
            if (transactionId) {
                storekit.finish(transactionId);
                // TH 08/03/2016: Remove the finished transaction from product.transactions.
                // Previously didn't clear transactions for these product types on finish.
                // storekitPurchased suppresses approved events for transactions in product.transactions,
                // so this prevented the approved event from firing when re-purchasing a product for which finish failed.
                if (product.transactions) {
                    var idx = product.transactions.indexOf(transactionId);
                    if (idx >= 0) product.transactions.splice(idx, 1);
                }
            }
            else {
                store.log.debug("ios -> error: unable to find transaction for " + product.id);
            }
        }
        else if (product.transactions) {
            store.log.debug("ios -> finishing all " + product.transactions.length + " transactions for " + product.id);
            for (var i = 0; i < product.transactions.length; ++i) {
                store.log.debug("ios -> finishing " + product.transactions[i]);
                storekit.finish(product.transactions[i]);
            }
            product.transactions = [];
        }
    }
    
    //! #### persist ownership
    //!
    //! `storekit` doesn't provide a way to know which products have been purchases.
    //! That is why we have to handle that ourselves, by storing the `OWNED` status of a product.
    //!
    //! Note that, until Apple provides a mean to get notified to refunds, there's no way back.
    //! A non-consumable product, once `OWNED` always will be.
    //!
    //! http://stackoverflow.com/questions/6429186/can-we-check-if-a-users-in-app-purchase-has-been-refunded-by-apple
    //!
    store.when("owned", function(product) {
        if (!isOwned(product.id))
            setOwned(product.id, true);
    });
    
    
    //! #### persist downloaded status
    //!
    //! `storekit` doesn't provide a way to know which products have been downloaded.
    //! That is why we have to handle that ourselves, by storing the `DOWNLOADED` status of a product.
    //!
    //! A non-consumable product, once `OWNED` can always be re-downloaded for free.
    //!
    store.when("downloaded", function(product) {
        if (!isDownloaded(product.id))
            setDownloaded(product.id, true);
    });
    
    store.when("registered", function(product) {
        var owned = isOwned(product.id);
        product.owned = product.owned || owned;
    
        var downloaded = isDownloaded(product.id);
        product.downloaded = product.downloaded || downloaded;
    
        store.log.debug("ios -> product " + product.id + " registered" + (owned ? " and owned" : "") + (downloaded ? " and downloaded" : ""));
    });
    
    store.when("expired", function(product) {
        store.log.debug("ios -> product " + product.id + " expired");
        product.owned = false;
        setOwned(product.id, false);
        setDownloaded(product.id, false);
        storekitFinish(product);
        if (product.state === store.OWNED || product.state === store.APPROVED)
            product.set("state", store.VALID);
    });
    
    //!
    //! ## Initialization
    //!
    
    //! ### <a name="storekitInit"></a> *storekitInit()*
    //!
    //! This funciton will initialize the storekit API.
    //!
    //! This initiates a chain reaction including [`storekitReady()`](#storekitReady) and [`storekitLoaded()`](#storekitLoaded)
    //! that will make sure products are loaded from server, set as `VALID` or `INVALID`, and eventually restored
    //! to their proper `OWNED` status.
    //!
    //! It also registers the `storekit` callbacks to get notified of events from the StoreKit API:
    //!
    //!  - [`storekitPurchasing()`](#storekitPurchasing)
    //!  - [`storekitPurchased()`](#storekitPurchased)
    //!  - [`storekitError()`](#storekitError)
    //!
    var initialized = false;
    var initializing = false;
    function storekitInit() {
        if (initialized || initializing) return;
        initializing = true;
        store.log.debug("ios -> initializing storekit");
        storekit.init({
            debug:    store.verbosity >= store.DEBUG ? true : false,
            autoFinish: store.autoFinishTransactions,
            error:    storekitError,
            purchase: storekitPurchased,
            purchasing: storekitPurchasing,
            restore:    storekitRestored,
            restoreCompleted: storekitRestoreCompleted,
            restoreFailed:    storekitRestoreFailed,
            downloadActive:  storekitDownloadActive,
            downloadFailed:  storekitDownloadFailed,
            downloadFinished:  storekitDownloadFinished,
            redirectionDone: storekitAppleStoreRedirectionDone,
        }, storekitReady, storekitInitFailed);
    }
    
    //!
    //! ## *storekit* events handlers
    //!
    
    //! ### <a name="storekitReady"></a> *storekitReady()*
    //!
    //! Called when `storekit` has been initialized successfully.
    //!
    //! Loads all registered products, triggers `storekitLoaded()` when done.
    //!
    
    function storekitAppleStoreRedirectionDone() {
        store.log.info("ios -> redirection done");
        store.trigger('redirection-done');
    }
    
    function storekitReady() {
        store.log.info("ios -> storekit ready");
        initializing = false;
        initialized = true;
        storekitLoad();
    }
    
    function storekitInitFailed() {
        store.log.warn("ios -> storekit init failed");
        initializing = false;
        retry(storekitInit);
    }
    
    var loaded = false;
    var loading = false;
    function storekitLoad() {
        if (!initialized) return;
        if (loaded || loading) return;
        loading = true;
        var products = [];
        for (var i = 0; i < store.products.length; ++i)
            products.push(store.products[i].id);
        store.log.debug("ios -> loading products");
        storekit.load(products, storekitLoaded, storekitLoadFailed);
    }
    
    //! ### <a name="storekitLoaded"></a> *storekitLoaded()*
    //!
    //! Update the `store`'s product definitions when they have been loaded.
    //!
    //!  1. Set the products state to `VALID` or `INVALID`
    //!  2. Trigger the "loaded" event
    //!  3. Set the products state to `OWNED` (if it is so)
    //!  4. Set the store status to "ready".
    //!
    function storekitLoaded(validProducts, invalidProductIds) {
        store.log.debug("ios -> products loaded");
        var p;
        for (var i = 0; i < validProducts.length; ++i) {
            p = store.products.byId[validProducts[i].id];
            store.log.debug("ios -> product " + p.id + " is valid (" + p.alias + ")");
            store.log.debug("ios -> owned? " + p.owned);
            p.set({
                title: validProducts[i].title,
                price: validProducts[i].price,
                priceMicros: validProducts[i].priceMicros,
                description: validProducts[i].description,
                currency: validProducts[i].currency,
                countryCode: validProducts[i].countryCode,
                state: store.VALID
            });
            p.trigger("loaded");
            if (isOwned(p.id)) {
                if (p.type === store.NON_CONSUMABLE)
                    p.set("state", store.OWNED);
                else // recheck subscriptions at each application start
                    p.set("state", store.APPROVED);
            }
        }
        for (var j = 0; j < invalidProductIds.length; ++j) {
            p = store.products.byId[invalidProductIds[j]];
            p.set("state", store.INVALID);
            store.log.warn("ios -> product " + p.id + " is NOT valid (" + p.alias + ")");
            p.trigger("loaded");
        }
    
        //! Note: the execution of "ready" is deferred to make sure state
        //! changes have been processed.
        setTimeout(function() {
            loading = false;
            loaded = true;
            store.ready(true);
        }, 1);
    }
    
    function storekitLoadFailed() {
        store.log.warn("ios -> loading products failed");
        loading = false;
        retry(storekitLoad);
    }
    
    var refreshCallbacks = [];
    var refreshing = false;
    function storekitRefreshReceipts(callback) {
        if (callback)
            refreshCallbacks.push(callback);
        if (refreshing)
            return;
        refreshing = true;
    
        function callCallbacks() {
            var callbacks = refreshCallbacks;
            refreshCallbacks = [];
            for (var i = 0; i < callbacks.length; ++i)
                callbacks[i]();
        }
    
        storekit.refreshReceipts(function() {
            // success
            refreshing = false;
            callCallbacks();
        },
        function() {
            // error
            refreshing = false;
            callCallbacks();
        });
    }
    
    // The better default is now for validation services to use the
    // `latest_receipt_info` field.
    // store.when("expired", function() {
    //     storekitRefreshReceipts();
    // });
    
    //! ### <a name="storekitPurchasing"></a> *storekitPurchasing()*
    //!
    //! Called by `storekit` when a purchase is in progress.
    //!
    //! It will set the product state to `INITIATED`.
    //!
    function storekitPurchasing(productId) {
        store.log.debug("ios -> is purchasing " + productId);
        store.ready(function() {
            var product = store.get(productId);
            if (!product) {
                store.log.warn("ios -> Product '" + productId + "' is being purchased. But isn't registered anymore! How come?");
                return;
            }
            if (product.state !== store.INITIATED)
                product.set("state", store.INITIATED);
        });
    }
    
    //! ### <a name="storekitPurchased"></a> *storekitPurchased()*
    //!
    //! Called by `storekit` when a purchase have been approved.
    //!
    //! It will set the product state to `APPROVED` and associates the product
    //! with the order's transaction identifier.
    //!
    function storekitPurchased(transactionId, productId) {
        store.ready(function() {
            var product = store.get(productId);
            if (!product) {
                store.error({
                    code: store.ERR_PURCHASE,
                    message: "The purchase queue contains unknown product " + productId
                });
                return;
            }
    
            // Check if processing of this transaction isn't already in progress
            // Exit if so.
            if (product.transactions) {
                for (var i = 0; i < product.transactions.length; ++i) {
                    if (transactionId === product.transactions[i])
                        return;
                }
            }
    
            product.transaction = {
                type: 'ios-appstore',
                id:   transactionId
            };
            if (!product.transactions)
                product.transactions = [];
            product.transactions.push(transactionId);
            store.log.info("ios -> transaction " + transactionId + " purchased (" + product.transactions.length + " in the queue for " + productId + ")");
            product.set("state", store.APPROVED);
        });
    }
    
    //! ### <a name="storekitError"></a> *storekitError()*
    //!
    //! Called by `storekit` when an error happens in the storekit API.
    //!
    //! Will convert storekit errors to a [`store.Error`](api.md/#errors).
    //!
    function storekitError(errorCode, errorText, options) {
    
        var i, p;
    
        if (!options)
            options = {};
    
        store.log.error('ios -> ERROR ' + errorCode + ': ' + errorText + ' - ' + JSON.stringify(options));
    
        // when loading failed, trigger "error" for each of
        // the registered products.
        if (errorCode === storekit.ERR_LOAD) {
            for (i = 0; i < store.products.length; ++i) {
                p = store.products[i];
                p.trigger("error", [new store.Error({
                    code: store.ERR_LOAD,
                    message: errorText
                }), p]);
            }
        }
    
        // a purchase was cancelled by the user:
        // - trigger the "cancelled" event
        // - set the product back to the VALID state
        if (errorCode === storekit.ERR_PAYMENT_CANCELLED) {
            p = store.get(options.productId);
            if (p) {
                p.trigger("cancelled");
                p.set({
                    transaction: null,
                    state: store.VALID
                });
            }
            // but a cancelled order isn't an error.
            return;
        }
    
        // TH 08/03/2016: Treat errors like cancellations:
        // - trigger the "error" event on the associated product
        // - set the product back to the VALID state
        // This makes it possible to know which product raised an error (previously, errors only fired on the global error listener, which obscures product id).
        // It also seems more consistent with the documented API. See https://github.com/j3k0/cordova-plugin-purchase/blob/master/doc/api.md#events and https://github.com/j3k0/cordova-plugin-purchase/blob/master/doc/api.md#notes
        p = store.get(options.productId);
        if (p) {
            p.trigger("error", [new store.Error({
                code:    errorCode,
                message: errorText
            }), p]);
            p.set({
                transaction: null,
                state: store.VALID
            });
        }
    
        store.error({
            code:    errorCode,
            message: errorText
        });
    }
    
    store.manageSubscriptions = function() {
        storekit.manageSubscriptions();
    };
    
    // Restore purchases.
    // store.restore = function() {
    // };
    store.when("re-refreshed", function() {
        storekit.restore();
        storekit.refreshReceipts(function(data) {
            // What the point of this?
            // Why create a product whose ID equals the application bundle ID (?)
            // Is it just to trigger force a validation of the appStoreReceipt?
            if (data) {
                var p = data.bundleIdentifier ? store.get(data.bundleIdentifier) : null;
                if (!p) {
                    p = new store.Product({
                        id:    data.bundleIdentifier || "application data",
                        alias: "application data",
                        type:  store.NON_CONSUMABLE
                    });
                    store.register(p);
                }
                p.version = data.bundleShortVersion;
                p.transaction = {
                    type: 'ios-appstore',
                    appStoreReceipt: data.appStoreReceipt,
                    signature: data.signature
                };
                p.trigger("loaded");
                p.set('state', store.APPROVED);
            }
        });
    });
    
    function storekitRestored(originalTransactionId, productId) {
        store.log.info("ios -> restored purchase " + productId);
        storekitPurchased(originalTransactionId, productId);
    }
    
    function storekitRestoreCompleted() {
        store.log.info("ios -> restore completed");
        store.trigger('refresh-completed');
    }
    
    function storekitRestoreFailed(/*errorCode*/) {
        store.log.warn("ios -> restore failed");
        store.error({
            code: store.ERR_REFRESH,
            message: "Failed to restore purchases during refresh"
        });
        store.trigger('refresh-failed');
    }
    
    function storekitDownloadActive(transactionIdentifier, productId, progress, timeRemaining) {
        store.log.info("ios -> is downloading " + productId + "; progress=" + progress + "%; timeRemaining=" + timeRemaining + "s");
        var p = store.get(productId);
        p.set({
            progress: progress,
            timeRemaining: timeRemaining,
            state: store.DOWNLOADING
        });
    }
    function storekitDownloadFailed(transactionIdentifier, productId, errorCode, errorText) {
        store.log.error("ios -> download failed: " + productId + "; errorCode=" + errorCode + "; errorText=" + errorText);
        var p = store.get(productId);
        p.trigger("error", [ new store.Error({
            code: store.ERR_DOWNLOAD,
            message: errorText
        }), p ]);
    
        store.error({
            code: errorCode,
            message: errorText
        });
    }
    function storekitDownloadFinished(transactionIdentifier, productId) {
        store.log.info("ios -> download completed: " + productId);
        var p = store.get(productId);
        p.set("state", store.DOWNLOADED);
    }
    
    store._refreshForValidation = function(callback) {
        storekitRefreshReceipts(callback);
    };
    
    // Load receipts required by server-side validation of purchases.
    store._prepareForValidation = function(product, callback) {
        var nRetry = 0;
        function loadReceipts() {
            storekit.setAppStoreReceipt(null);
            storekit.loadReceipts(function(r) {
                if (!product.transaction) {
                    product.transaction = {
                        type: 'ios-appstore'
                    };
                }
                product.transaction.appStoreReceipt = r.appStoreReceipt;
                if (product.transaction.id)
                    product.transaction.transactionReceipt = r.forTransaction(product.transaction.id);
                if (!product.transaction.appStoreReceipt && !product.transaction.transactionReceipt) {
                    nRetry ++;
                    if (nRetry < 2) {
                        setTimeout(loadReceipts, 500);
                        return;
                    }
                    else if (nRetry === 2) {
                        storekit.refreshReceipts(loadReceipts);
                        return;
                    }
                }
                callback();
            });
        }
        loadReceipts();
    };
    
    //!
    //! ## Persistance of the *OWNED* status
    //!
    
    //! #### *isOwned(productId)*
    //! return true iff the product with given ID has been purchased and finished
    //! during this or a previous execution of the application.
    function isOwned(productId) {
        return localStorage["__cc_fovea_store_ios_owned_ " + productId] === '1';
    }
    
    //! #### *setOwned(productId, value)*
    //! store the boolean OWNED status of a given product.
    function setOwned(productId, value) {
        store.log.debug("ios -> product " + productId + " owned=" + (value ? "true" : "false"));
        localStorage["__cc_fovea_store_ios_owned_ " + productId] = value ? '1' : '0';
    }
    
    
    //!
    //! ## Persistance of the *DOWNLOADED* status
    //!
    
    //! #### *isDownloaded(productId)*
    //! return true if the product with given ID has been purchased and finished downloading
    //! during this or a previous execution of the application.
        function isDownloaded(productId) {
            return localStorage["__cc_fovea_store_ios_downloaded_ " + productId] === '1';
        }
    
    //! #### *setDownloaded(productId, value)*
    //! store the boolean DOWNLOADED status of a given product.
        function setDownloaded(productId, value) {
            localStorage["__cc_fovea_store_ios_downloaded_ " + productId] = value ? '1' : '0';
        }
    
    //!
    //! ## Retry failed requests
    //! When setup and/or load failed, the plugin will retry over and over till it can connect
    //! to the store.
    //!
    //! However, to be nice with the battery, it'll double the retry timeout each time.
    //!
    //! Special case, when the device goes online, it'll trigger all retry callback in the queue.
    var retryTimeout = 5000;
    var retries = [];
    function retry(fn) {
    
        var tid = setTimeout(function() {
            retries = retries.filter(function(o) {
                return tid !== o.tid;
            });
            fn();
        }, retryTimeout);
    
        retries.push({ tid: tid, fn: fn });
    
        retryTimeout *= 2;
        // Max out the waiting time to 2 minutes.
        if (retryTimeout > 120000)
            retryTimeout = 120000;
    }
    
    document.addEventListener("online", function() {
        var a = retries;
        retries = [];
        retryTimeout = 5000;
        for (var i = 0; i < a.length; ++i) {
            clearTimeout(a[i].tid);
            a[i].fn.call(this);
        }
    }, false);
    
    })();
    
// Site-wide behaviour: form validation, navigation, scroll effects, sliders, filters, carousel, cookie banner.
// Edit this file directly, then bump the ?v= cache-buster on every page that loads it.
!(function () {
  "use strict";
  var runWhenIdle = function (callback) {
    var schedule = function () {
      if ("requestIdleCallback" in window) {
        requestIdleCallback(callback, { timeout: 2000 });
      } else {
        setTimeout(callback, 200);
      }
    };
    if ("complete" === document.readyState) {
      schedule();
    } else {
      window.addEventListener("load", schedule, { once: true });
    }
  };
  var debounce = function (fn, delay) {
      var timer;
      return function () {
        var args = arguments,
          context = this;
        clearTimeout(timer);
        timer = setTimeout(function () {
          fn.apply(context, args);
        }, delay);
      };
    },
    prefersReducedMotion = function () {
      return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    },
    qs = function (selector, scope) {
      return (scope || document).querySelector(selector);
    },
    qsa = function (selector, scope) {
      return (scope || document).querySelectorAll(selector);
    };
  // Validates every form[data-netlify="true"] on submit: required fields, email, phone, upload type and size.
  function initFormValidation() {
    var forms = qsa('form[data-netlify="true"]');
    if (forms.length) {
      var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
        phonePattern = /^[\d\s\-+().]{7,20}$/,
        documentMimeTypes = [
          "application/pdf",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
        showError = function (field, message) {
          clearError(field);
          field.setAttribute("aria-invalid", "true");
          var errorId = (field.id || field.name) + "-error",
            errorEl = document.createElement("span"),
            anchor =
              (/^(checkbox|radio)$/.test(field.type) && field.closest("fieldset,.form-group")) || field;
          errorEl.className = "form-error";
          errorEl.id = errorId;
          errorEl.textContent = message;
          errorEl.setAttribute("role", "alert");
          field.setAttribute("aria-describedby", errorId);
          anchor.parentNode.insertBefore(errorEl, anchor.nextSibling);
        },
        clearError = function (field) {
          field.removeAttribute("aria-invalid");
          field.removeAttribute("aria-describedby");
          var errorEl = document.getElementById((field.id || field.name) + "-error");
          if (errorEl) {
            errorEl.remove();
          }
        },
        acceptTokens = function (input) {
          return (input.getAttribute("accept") || "")
            .toLowerCase()
            .split(",")
            .map(function (token) {
              return token.trim();
            })
            .filter(Boolean);
        },
        isAcceptedFile = function (tokens, file) {
          var fileName = file.name.toLowerCase();
          return tokens.length
            ? tokens.some(function (token) {
                return "." === token.charAt(0)
                  ? fileName.slice(-token.length) === token
                  : "/*" === token.slice(-2)
                    ? 0 === file.type.indexOf(token.slice(0, -1))
                    : file.type === token;
              })
            : -1 !== documentMimeTypes.indexOf(file.type);
        };
      forms.forEach(function (form) {
        form.setAttribute("novalidate", "");
        form.addEventListener("submit", function (event) {
          if (event.defaultPrevented) {
            return;
          }
          form.querySelectorAll("[aria-invalid]").forEach(function (control) {
            clearError(control);
          });
          var controls = form.querySelectorAll("input, textarea, select"),
            allValid = true,
            firstInvalid = null;
          if (
            (controls.forEach(function (control) {
              if ("hidden" !== control.type && "submit" !== control.type) {
                if (
                  !(function (field) {
                    var type = field.type || "text",
                      value = field.value.trim(),
                      isChoice = "checkbox" === type || "radio" === type;
                    if (field.hasAttribute("required") && (isChoice ? field.validity.valueMissing : !value)) {
                      return (
                        showError(
                          field,
                          "checkbox" === type
                            ? "Please check this box to continue."
                            : "radio" === type
                              ? "Please select an option."
                              : "This field is required.",
                        ),
                        false
                      );
                    }
                    if (!value || isChoice) {
                      return true;
                    }
                    if ("email" === type && !emailPattern.test(value)) {
                      return showError(field, "Please enter a valid email address."), false;
                    }
                    if ("tel" === type && !phonePattern.test(value)) {
                      return showError(field, "Please enter a valid phone number."), false;
                    }
                    if ("file" === field.type && field.files && field.files.length) {
                      for (
                        var fileIndex = 0, tokens = acceptTokens(field);
                        fileIndex < field.files.length;
                        fileIndex++
                      ) {
                        if (!isAcceptedFile(tokens, field.files[fileIndex])) {
                          return (
                            showError(
                              field,
                              "Accepted formats: " +
                                (tokens.length
                                  ? tokens
                                      .map(function (token) {
                                        return token.replace(/^\./, "").toUpperCase();
                                      })
                                      .join(", ")
                                  : "PDF, Excel, Word") +
                                ".",
                            ),
                            false
                          );
                        }
                        if (field.files[fileIndex].size > 10485760) {
                          return showError(field, "File must be under 10 MB."), false;
                        }
                      }
                    }
                    return true;
                  })(control)
                ) {
                  allValid = false;
                  if (!firstInvalid) {
                    firstInvalid = control;
                  }
                }
              }
            }),
            !allValid)
          ) {
            return event.preventDefault(), void (firstInvalid && firstInvalid.focus());
          }
          var submitButton = form.querySelector('[type="submit"]');
          if (submitButton) {
            submitButton.disabled = true;
            submitButton.setAttribute("data-original-text", submitButton.textContent);
            submitButton.textContent = "Sending…";
          }
        });
      });
    }
  }
  // Count-up animation for .hero__stat-value[data-count].
  function initStatCounters() {
    var counters = qsa(".hero__stat-value[data-count]");
    if (counters.length && "IntersectionObserver" in window && !prefersReducedMotion()) {
      var started = false,
        animateCount = function (element, target, suffix, duration) {
          var startTime = null,
            step = function (timestamp) {
              if (!startTime) {
                startTime = timestamp;
              }
              var linear,
                progress = Math.min((timestamp - startTime) / duration, 1),
                current = Math.round(((linear = progress), (1 - Math.pow(1 - linear, 3)) * target));
              element.textContent = (target >= 1000 ? current.toLocaleString() : String(current)) + suffix;
              if (progress < 1) {
                requestAnimationFrame(step);
              } else {
                element.textContent = (target >= 1000 ? target.toLocaleString() : String(target)) + suffix;
              }
            };
          requestAnimationFrame(step);
        },
        observer = new IntersectionObserver(
          function (entries) {
            entries.forEach(function (entry) {
              if (entry.isIntersecting && !started) {
                started = true;
                observer.disconnect();
                counters.forEach(function (counter) {
                  var targetValue = parseInt(counter.getAttribute("data-count"), 10);
                  if (!isNaN(targetValue)) {
                    var suffix = counter.textContent.trim().replace(/[,\d]/g, "").trim() || "";
                    counter.textContent = "0" + suffix;
                    animateCount(counter, targetValue, suffix, 1500);
                  }
                });
              }
            });
          },
          { threshold: 0.5 },
        ),
        section = counters[0].closest("section") || counters[0].parentElement;
      if (section) {
        observer.observe(section);
      }
    }
  }
  document.addEventListener("DOMContentLoaded", function () {
    var sliders,
      trackCards,
      hero = qs(".hero"),
      navScrollThreshold = 400,
      sectionLinks = qsa('.nav__links .nav__link[href^="#"]'),
      sections = [];
    // Scrollspy: record each section's offset once the page is idle.
    (function () {
      function measureSections() {
        sectionLinks.forEach(function (link) {
          var href = link.getAttribute("href");
          if (href && href.length > 1) {
            var section = qs(href);
            if (section) {
              sections.push({
                el: section,
                link: link,
                top: section.offsetTop,
              });
            }
          }
        });
      }
      if (sectionLinks.length) {
        runWhenIdle(measureSections);
      }
    })();
    // Mobile navigation panel.
    (function () {
      var toggleButton = qs(".nav__mobile-btn"),
        panel = qs("#mobileNav");
      if (toggleButton && panel) {
        var closePanel = function () {
          panel.classList.remove("is-open");
          toggleButton.setAttribute("aria-expanded", "false");
          document.body.style.overflow = "";
        };
        toggleButton.addEventListener("click", function (event) {
          event.stopPropagation();
          if (panel.classList.contains("is-open")) {
            closePanel();
          } else {
            panel.classList.add("is-open");
            toggleButton.setAttribute("aria-expanded", "true");
            document.body.style.overflow = "hidden";
          }
        });
        panel.addEventListener("click", function (event) {
          if ("A" === event.target.tagName) {
            closePanel();
          }
        });
        document.addEventListener("click", function (event) {
          if (
            !(
              !panel.classList.contains("is-open") ||
              panel.contains(event.target) ||
              toggleButton.contains(event.target)
            )
          ) {
            closePanel();
          }
        });
        document.addEventListener("keydown", function (event) {
          if ("Escape" === event.key && panel.classList.contains("is-open")) {
            closePanel();
          }
        });
      }
    })();
    // In-page anchor scrolling that respects prefers-reduced-motion.
    document.addEventListener("click", function (event) {
      var anchor = event.target.closest('a[href^="#"]');
      if (anchor) {
        var href = anchor.getAttribute("href");
        if (!("#" === href || href.length < 2)) {
          var target = qs(href);
          if (target) {
            event.preventDefault();
            var top = target.getBoundingClientRect().top + window.pageYOffset - 72;
            if (prefersReducedMotion()) {
              window.scrollTo(0, top);
            } else {
              window.scrollTo({
                top: top,
                behavior: "smooth",
              });
            }
            target.setAttribute("tabindex", "-1");
            target.focus({ preventScroll: true });
          }
        }
      }
    });
    // Fade-in on scroll.
    (function () {
      var items = qsa(".animate-on-scroll");
      if (items.length) {
        if (!prefersReducedMotion() && "IntersectionObserver" in window) {
          var observer = new IntersectionObserver(
            function (entries) {
              entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                  entry.target.classList.add("is-visible");
                  observer.unobserve(entry.target);
                }
              });
            },
            {
              threshold: 0.15,
              rootMargin: "-48px",
            },
          );
          items.forEach(function (item) {
            observer.observe(item);
          });
        } else {
          items.forEach(function (item) {
            item.classList.add("is-visible");
          });
        }
      }
    })();
    // Before/after sliders (mouse, touch and keyboard).
    if ((sliders = qsa(".ba-slider")).length) {
      sliders.forEach(function (slider) {
        var handle = qs(".ba-slider__handle", slider),
          beforePane = qs(".ba-slider__before", slider);
        if (handle && beforePane) {
          var dragging = false,
            setPosition = function (percent) {
              var clamped = Math.max(0, Math.min(100, percent)),
                rounded = Math.round(clamped);
              beforePane.style.clipPath = "inset(0 " + (100 - clamped) + "% 0 0)";
              handle.style.left = clamped + "%";
              handle.setAttribute("aria-valuenow", rounded);
              var label =
                rounded <= 0
                  ? "0% — before view"
                  : rounded >= 100
                    ? "100% — after view"
                    : rounded === 50
                      ? "50% — before and after equally visible"
                      : rounded < 50
                        ? rounded + "% — mostly before"
                        : rounded + "% — mostly after";
              handle.setAttribute("aria-valuetext", label);
            };
          setPosition(50);
          var percentFromX = function (clientX) {
            var rect = slider.getBoundingClientRect();
            return ((clientX - rect.left) / rect.width) * 100;
          };
          handle.addEventListener("mousedown", function (event) {
            event.preventDefault();
            dragging = true;
          });
          document.addEventListener("mousemove", function (event) {
            if (dragging) {
              setPosition(percentFromX(event.clientX));
            }
          });
          document.addEventListener("mouseup", function () {
            dragging = false;
          });
          handle.addEventListener(
            "touchstart",
            function (event) {
              event.preventDefault();
              dragging = true;
            },
            { passive: false },
          );
          document.addEventListener(
            "touchmove",
            function (event) {
              if (dragging) {
                setPosition(percentFromX(event.touches[0].clientX));
              }
            },
            { passive: true },
          );
          document.addEventListener("touchend", function () {
            dragging = false;
          });
          handle.addEventListener("keydown", function (event) {
            var current = parseFloat(handle.style.left) || 50;
            switch (event.key) {
              case "ArrowLeft":
              case "ArrowDown":
                event.preventDefault();
                setPosition(current - 2);
                break;
              case "ArrowRight":
              case "ArrowUp":
                event.preventDefault();
                setPosition(current + 2);
                break;
              case "Home":
                event.preventDefault();
                setPosition(0);
                break;
              case "End":
                event.preventDefault();
                setPosition(100);
                break;
              case "PageDown":
                event.preventDefault();
                setPosition(current - 10);
                break;
              case "PageUp":
                event.preventDefault();
                setPosition(current + 10);
                break;
            }
          });
          slider.addEventListener("click", function (event) {
            if (!(event.target === handle || handle.contains(event.target))) {
              setPosition(percentFromX(event.clientX));
            }
          });
        }
      });
    }
    // Portfolio market filters.
    (function () {
      var filters = qs(".portfolio-filters");
      if (filters) {
        var buttons = qsa(".filter-btn[data-filter]", filters),
          cards = qsa(".portfolio-card[data-market]");
        if (buttons.length && cards.length) {
          buttons.forEach(function (button) {
            button.addEventListener("click", function () {
              buttons.forEach(function (button) {
                button.classList.remove("filter-btn--active");
              });
              button.classList.add("filter-btn--active");
              buttons.forEach(function (button) {
                button.setAttribute("aria-pressed", "false");
              });
              button.setAttribute("aria-pressed", "true");
              var filter = button.getAttribute("data-filter") || "all";
              cards.forEach(function (card) {
                var market = card.getAttribute("data-market") || "";
                if ("all" === filter || market.toLowerCase() === filter.toLowerCase()) {
                  card.style.display = "";
                  card.classList.remove("fade-out");
                  card.classList.add("fade-in");
                } else {
                  card.classList.remove("fade-in");
                  card.classList.add("fade-out");
                  setTimeout(function () {
                    if (card.classList.contains("fade-out")) {
                      card.style.display = "none";
                    }
                  }, 300);
                }
              });
            });
          });
        }
      }
    })();
    // Testimonial carousel: auto-advance while in view, dots, swipe.
    (function () {
      var carousel = qs(".testimonial-carousel");
      if (carousel) {
        var track = qs("#testimonialTrack", carousel),
          dotsWrap = qs(".testimonial-dots", carousel);
        if (track) {
          var slides = qsa(".testimonial", track);
          if (slides.length) {
            var dots = dotsWrap ? qsa(".testimonial-dot", dotsWrap) : [],
              index = 0,
              timer = null,
              paused = false,
              inView = true,
              tabVisible = !("hidden" === document.visibilityState),
              touchStartX = 0,
              showSlide = function (target) {
                index = ((target % slides.length) + slides.length) % slides.length;
                slides.forEach(function (slide, i) {
                  var isActive = i === index;
                  slide.setAttribute("aria-hidden", String(!isActive));
                  slide.style.display = isActive ? "" : "none";
                });
                dots.forEach(function (dot, i) {
                  dot.classList.toggle("testimonial-dot--active", i === index);
                  dot.setAttribute("aria-current", String(i === index));
                });
                restartTimer();
              },
              nextSlide = function () {
                showSlide(index + 1);
              },
              restartTimer = function () {
                clearInterval(timer);
                if (!paused && inView && tabVisible) {
                  timer = setInterval(nextSlide, 8000);
                }
              };
            if (dotsWrap) {
              dotsWrap.addEventListener("click", function (event) {
                var dot = event.target.closest(".testimonial-dot");
                if (dot) {
                  var i = Array.from(dots).indexOf(dot);
                  if (i >= 0) {
                    showSlide(i);
                  }
                }
              });
            }
            carousel.addEventListener("mouseenter", function () {
              paused = true;
              clearInterval(timer);
            });
            carousel.addEventListener("mouseleave", function () {
              paused = false;
              restartTimer();
            });
            if ("IntersectionObserver" in window) {
              inView = false;
              new IntersectionObserver(
                function (entries) {
                  entries.forEach(function (entry) {
                    inView = entry.isIntersecting;
                    restartTimer();
                  });
                },
                { threshold: 0.25 },
              ).observe(carousel);
            }
            document.addEventListener("visibilitychange", function () {
              tabVisible = "hidden" !== document.visibilityState;
              restartTimer();
            });
            carousel.addEventListener(
              "touchstart",
              function (event) {
                touchStartX = event.changedTouches[0].screenX;
              },
              { passive: true },
            );
            carousel.addEventListener(
              "touchend",
              function (event) {
                var delta = touchStartX - event.changedTouches[0].screenX;
                if (Math.abs(delta) > 50) {
                  showSlide(delta > 0 ? index + 1 : index - 1);
                }
              },
              { passive: true },
            );
            showSlide(0);
          }
        }
      }
    })();
    initFormValidation();
    // Cookie banner; storage access is wrapped because it can throw when blocked.
    (function () {
      var getItem = function (key) {
          try {
            return localStorage.getItem(key);
          } catch (error) {
            return null;
          }
        },
        setItem = function (key, value) {
          try {
            localStorage.setItem(key, value);
          } catch (error) {}
        };
      if (!getItem("oxford-cookies-accepted") && !getItem("oxford-cookies-declined")) {
        var banner = qs("#cookieBanner");
        if (banner) {
          banner.style.display = "";
          banner.classList.add("visible");
          // Publish the banner's live height so the fixed chat launcher
          // (assets/chat.css) can sit above it instead of on top of it.
          var root = document.documentElement,
            syncBannerHeight = function () {
              root.style.setProperty("--cookie-banner-h", banner.offsetHeight + "px");
            };
          syncBannerHeight();
          if ("ResizeObserver" in window) {
            new ResizeObserver(syncBannerHeight).observe(banner);
          } else {
            window.addEventListener("resize", syncBannerHeight);
          }
          var hideBanner = function () {
              banner.classList.remove("visible");
              banner.classList.add("hidden");
              setTimeout(function () {
                banner.style.display = "none";
              }, 400);
            },
            acceptButton = qs("#cookieAccept"),
            declineButton = qs("#cookieDecline");
          if (acceptButton) {
            acceptButton.addEventListener("click", function () {
              setItem("oxford-cookies-accepted", "true");
              hideBanner();
            });
          }
          if (declineButton) {
            declineButton.addEventListener("click", function () {
              setItem("oxford-cookies-declined", "true");
              hideBanner();
            });
          }
        }
      }
    })();
    initStatCounters();
    // Track-record card expanders.
    if ((trackCards = qsa(".track-card__summary")).length) {
      trackCards.forEach(function (summary) {
        var card = summary.closest(".track-card"),
          toggle = function () {
            card.classList.toggle("track-card--expanded");
            summary.setAttribute("aria-expanded", String(card.classList.contains("track-card--expanded")));
          };
        summary.addEventListener("click", toggle);
        summary.addEventListener("keydown", function (event) {
          if ("Enter" === event.key || " " === event.key) {
            event.preventDefault();
            toggle();
          }
        });
      });
    }
    // Nav bar "scrolled" state once past 60% of the threshold.
    (function (threshold) {
      var nav = qs("nav.nav");
      if (nav) {
        var update = function () {
          if (window.pageYOffset > 0.6 * threshold) {
            nav.classList.add("scrolled");
          } else {
            nav.classList.remove("scrolled");
          }
        };
        window.addEventListener("scroll", debounce(update, 16), { passive: true });
        runWhenIdle(update);
      }
    })(navScrollThreshold);
    // Scrollspy: highlight the nav link for the section in view.
    (function (trackedSections) {
      var links = qsa('.nav__links .nav__link[href^="#"]');
      if (links.length) {
        var update = function () {
          for (
            var scrollPosition = window.pageYOffset + 72 + 50,
              activeIndex = -1,
              index = trackedSections.length - 1;
            index >= 0;
            index--
          ) {
            if (scrollPosition >= trackedSections[index].top) {
              activeIndex = index;
              break;
            }
          }
          links.forEach(function (link) {
            link.classList.remove("nav__link--active");
          });
          if (activeIndex >= 0) {
            trackedSections[activeIndex].link.classList.add("nav__link--active");
          }
        };
        window.addEventListener("scroll", debounce(update, 16), { passive: true });
        window.addEventListener(
          "resize",
          debounce(function () {
            trackedSections.forEach(function (section) {
              section.top = section.el.offsetTop;
            });
          }, 200),
          { passive: true },
        );
        runWhenIdle(update);
      }
    })(sections);
  });
})();
// Announcement bar rotator.
(function () {
  var items = document.querySelectorAll(".announcement-bar__item");
  if (items.length < 2) {
    return;
  }
  var current = 0;
  setInterval(function () {
    items[current].classList.remove("is-active");
    current = (current + 1) % items.length;
    items[current].classList.add("is-active");
  }, 4000);
})();

/**
 * Show Alert Box Tool
 * Displays a browser alert dialog with a custom message
 */
class ShowAlertTool extends FunctionCallDefinition {
  constructor() {
    super(
      "show_alert",
      "Displays an alert dialog box with a message to the user",
      {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The message to display in the alert box"
          },
          title: {
            type: "string",
            description: "Optional title prefix for the alert message"
          }
        }
      },
      ["message"]
    );
  }

  functionToCall(parameters) {
    const message = parameters.message || "Alert!";
    const title = parameters.title;

    // Construct the full alert message
    const fullMessage = title ? `${title}: ${message}` : message;

    // Show the alert
    alert(fullMessage);

    console.log(` Alert shown: ${fullMessage}`);
  }
}
/**
 * Add CSS Style Tool
 * Injects CSS styles into the current page with !important flag
 */
class AddCSSStyleTool extends FunctionCallDefinition {
  constructor() {
    super(
      "add_css_style",
      "Injects CSS styles into the current page with !important flag. Use this tool whenever asked to change the background color, styles, colors, or appearance of the page.",
      {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector to target elements (e.g., 'body' for page background, '.main-content', '.sidebar', '#id')"
          },
          property: {
            type: "string",
            description: "CSS property to set (e.g., 'background-color', 'color', 'font-size')"
          },
          value: {
            type: "string",
            description: "Value for the CSS property (e.g., 'red', '#4f46e5', 'none')"
          },
          styleId: {
            type: "string",
            description: "Optional ID for the style element (for updating existing styles)"
          }
        }
      },
      ["selector", "property", "value"],
      "NON_BLOCKING"
    );
    this.scheduling = "SILENT";
  }

  functionToCall(parameters) {
    let { selector, property, value, styleId } = parameters;
    if (!selector || !property || !value) {
      console.warn("add_css_style: missing parameters", parameters);
      return "failed: missing selector, property, or value";
    }

    property = property.trim();
    value = value.trim();
    selector = selector.trim();

    // Check if modifying page background
    const isBgProperty =
      property.toLowerCase() === "background" ||
      property.toLowerCase() === "background-color";
    const isBodySelector = ["body", "html", ":root", "*"].includes(
      selector.toLowerCase()
    );

    if (isBgProperty && isBodySelector) {
      // Update root CSS variable so the entire layout updates smoothly
      document.documentElement.style.setProperty("--bg-main", value);
      document.body.style.setProperty("background-color", value, "important");
      selector = "body, .main-content, .chat-viewport, .app-layout, :root";
    } else if (isBgProperty) {
      const matched = document.querySelectorAll(selector);
      matched.forEach((el) => el.style.setProperty(property, value, "important"));
    }

    // Create or find the style element
    let styleElement;
    if (styleId) {
      styleElement = document.getElementById(styleId);
      if (!styleElement) {
        styleElement = document.createElement("style");
        styleElement.id = styleId;
        document.head.appendChild(styleElement);
      }
    } else {
      styleElement = document.getElementById("injected-gemini-styles");
      if (!styleElement) {
        styleElement = document.createElement("style");
        styleElement.id = "injected-gemini-styles";
        document.head.appendChild(styleElement);
      }
    }

    // Create the CSS rule with !important
    const cssRule = `${selector} { ${property}: ${value} !important; }\n`;

    // Add the CSS rule to the style element
    if (styleId) {
      styleElement.textContent = cssRule;
    } else {
      styleElement.textContent += cssRule;
    }

    console.log(`🎨 CSS style injected: ${cssRule}`);
    console.log(
      `   Applied to ${document.querySelectorAll(selector).length} element(s)`
    );
    return `Successfully applied ${property}: ${value} to ${selector}`;
  }
}

/**
 * Get Order Tool
 * Simulates an async backend call to fetch an order by ID.
 * Non-blocking: sleeps for 5 seconds then returns a mock order object.
 */
class GetOrderTool extends FunctionCallDefinition {
  constructor() {
    super(
      "get_order",
      "Fetches the details of a customer order by order ID. This is an async operation that may take a few seconds.",
      {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The unique identifier of the order to retrieve (e.g. 'ORD-1234')"
          }
        }
      },
      ["order_id"],
      "NON_BLOCKING" // Tell the API to run this tool asynchronously
    );
  }

  async functionToCall(parameters) {
    const orderId = parameters.order_id || "ORD-UNKNOWN";
    console.log(`📦 get_order called for ${orderId} — waiting 5s to simulate backend fetch...`);

    // Non-blocking 5-second delay simulating an async backend request
    await new Promise((resolve) => setTimeout(resolve, 15000));

    const mockOrder = {
      order_id: orderId,
      status: "shipped",
      customer: {
        name: "Alex Johnson",
        email: "alex.johnson@example.com"
      },
      items: [
        { sku: "WIDGET-42", name: "Super Widget", quantity: 2, unit_price_usd: 19.99 },
        { sku: "GADGET-7", name: "Mega Gadget", quantity: 1, unit_price_usd: 49.99 }
      ],
      total_usd: 89.97,
      estimated_delivery: "2026-08-11",
      tracking_number: "1Z999AA10123456784"
    };

    console.log(`✅ get_order resolved for ${orderId}:`, mockOrder);
    return mockOrder;
  }
}

/**
 * Draw SVG Tool
 * Paints a full SVG drawing on the page.
 * Non-blocking: model can keep speaking. Silent: does not interrupt.
 */
class DrawSVGTool extends FunctionCallDefinition {
  constructor() {
    super(
      "draw_svg",
      "Paints a full SVG drawing on the page. Use this tool when asked to draw, sketch, or generate custom SVG vector graphics.",
      {
        type: "object",
        properties: {
          svg: {
            type: "string",
            description: "The full SVG XML string to render (including <svg> ... </svg> tags)"
          }
        }
      },
      ["svg"],
      "NON_BLOCKING"
    );
    this.scheduling = "SILENT";
  }

  functionToCall(parameters) {
    const svgString = parameters.svg;
    if (!svgString) {
      console.warn("draw_svg tool: No SVG string provided");
      return "failed: No SVG string provided";
    }

    const container = document.getElementById("svgContainer");
    const section = document.getElementById("svgSection");
    const chatContainer = document.getElementById("chatContainer");

    // 1. Render inline message bubble in the chat flow
    if (chatContainer) {
      const msgDiv = document.createElement("div");
      msgDiv.className = "assistant svg-chat-bubble";
      msgDiv.style.background = "#ffffff";
      msgDiv.style.border = "1px solid #cbd5e1";
      msgDiv.style.borderLeft = "4px solid #2563eb";
      msgDiv.style.padding = "20px";
      msgDiv.style.borderRadius = "16px";
      msgDiv.style.margin = "12px 0";
      msgDiv.style.boxShadow = "0 4px 16px rgba(0, 0, 0, 0.06)";

      msgDiv.innerHTML = `
        <div style="font-size:0.75rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#2563eb; margin-bottom:12px; display:flex; align-items:center; gap:6px;">
          <span>✦ RENDERED SVG GRAPHIC</span>
        </div>
        <div class="svg-inline-render" style="display:flex; justify-content:center; align-items:center; width:100%; overflow:auto; background:#ffffff; padding:12px; border-radius:8px; border:1px solid #f1f5f9;">
          ${svgString}
        </div>
      `;

      chatContainer.appendChild(msgDiv);
    }

    // 2. Also populate standalone container if present
    if (container && section) {
      container.innerHTML = svgString;
      section.style.display = "block";
    }

    // 3. Smooth autoscroll to reveal the SVG
    setTimeout(() => {
      if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
        if (chatContainer.parentElement) {
          chatContainer.parentElement.scrollTop = chatContainer.parentElement.scrollHeight;
        }
      }
    }, 50);

    console.log("🎨 SVG rendered successfully");
    return "ok";
  }
}


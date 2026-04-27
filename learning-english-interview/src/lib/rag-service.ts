export interface RAGResult {
  snippets: string[];
}

export const queryRAG = async (query: string): Promise<RAGResult> => {
  const projectId = localStorage.getItem("gcp_project_id") || "";
  const dataStoreId = localStorage.getItem("gcp_datastore_id") || "";
  const token = localStorage.getItem("gcp_access_token") || "";

  if (!projectId || !dataStoreId || !token) {
    console.warn("GCP RAG settings missing. Using Mock RAG fallback.");
    return mockRAGQuery(query);
  }

  const endpoint = `https://discoveryengine.googleapis.com/v1alpha/projects/${projectId}/locations/global/collections/default_collection/dataStores/${dataStoreId}/servingConfigs/default_servingConfig:search`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query,
        pageSize: 3,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Vertex AI Search RAG Error:", errorText);
      return mockRAGQuery(query); // Fallback to mock
    }

    const data = await response.json();
    const snippets: string[] = [];

    if (data.results) {
      for (const result of data.results) {
        if (result.document && result.document.derivedStructData && result.document.derivedStructData.snippets) {
          for (const snippet of result.document.derivedStructData.snippets) {
            if (snippet.snippet) snippets.push(snippet.snippet);
          }
        }
      }
    }

    return { snippets };
  } catch (error) {
    console.error("RAG Query Failed:", error);
    return mockRAGQuery(query);
  }
};

const mockRAGQuery = async (query: string): Promise<RAGResult> => {
  // Simulate some time passing to query RAG
  await new Promise(resolve => setTimeout(resolve, 500));
  
  const lowercaseQuery = query.toLowerCase();
  const snippets: string[] = [];

  if (lowercaseQuery.includes("cap") || lowercaseQuery.includes("open")) {
    snippets.push("The aluminum cap requires a counter-clockwise twist of approximately 90 degrees to break the seal.");
    snippets.push("Some users report the cap edge can be sharp. Users should be advised to grip with the palm or use a rubber grip tool.");
  }
  if (lowercaseQuery.includes("leak") || lowercaseQuery.includes("spill") || lowercaseQuery.includes("seal")) {
    snippets.push("The bottle neck thread has a tolerance of +/- 0.2mm. Misalignment can cause slow leaks when tilted.");
  }
  if (snippets.length === 0) {
    snippets.push("General product guideline: The soda bottle is made of PET plastic and holds 500ml of carbonated beverage. Carbonation level is standard 3.5 volumes.");
  }

  return { snippets };
};
